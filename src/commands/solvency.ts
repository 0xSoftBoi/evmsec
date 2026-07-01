import { Contract, formatUnits } from "ethers";
import { ChainConfig, chain } from "../config.js";
import {
  ERC20_ABI,
  backingPct,
  blockAtOrBefore,
  blockLink,
  firstBreachBlock,
  getBlockCached,
  getProvider,
  isUnderBacked,
  mapWithConcurrency,
  requireAddress,
  shortAddr,
  to18,
  withRetry,
} from "../lib.js";
import { Route, LockLeg, loadRoutes, findRoute, lockLegs } from "../bridges.js";
import { sumLocked18, isRouteFailing, computeTransitions, computeDegrades } from "../solvency-core.js";
import { AGGREGATOR_ABI, fmtUsd, priceRouteFor, priceFromHops, usdValue, type HopReading } from "../usd-core.js";

/** How many routes `--all` checks at once (override via EVMSEC_CONCURRENCY). */
const ROUTE_CONCURRENCY = Number(process.env.EVMSEC_CONCURRENCY) || 5;

export interface SolvencyResult {
  id: string;
  bridge: string;
  asset: string;
  lockChain: string;
  mintChain: string;
  locked: string;
  minted: string;
  ratioPct: number | null;
  delta: string;
  verdict: "BACKED" | "UNDERCOLLATERALIZED" | "NO_SUPPLY" | "ERROR";
  /** Present only when verdict is ERROR — the read that failed. */
  error?: string;
  /**
   * USD valuation via Chainlink — best-effort. Absent when no feed covers the
   * asset or a price read failed; a missing price never fails the backing check.
   */
  priceUsd?: number;
  lockedUsd?: number;
  mintedUsd?: number;
  deltaUsd?: number;
  /** Feed provenance, e.g. "BTC/USD" or "cbETH/ETH × ETH/USD". */
  pricedVia?: string;
}

/**
 * `evmsec solvency <route-id | --all | ad-hoc>` — point-in-time backing check.
 * `evmsec solvency <route> --since <block|date>` — forensic: binary-search
 *   history for the exact destination-chain block where backing first broke.
 */
export async function solvency(args: string[]): Promise<void> {
  const opts = parse(args);

  if (opts.since !== undefined) {
    const route = opts.adHoc ?? (opts.id ? findRoute(opts.id) : undefined);
    if (!route) throw new Error("`--since` needs a route id or ad-hoc flags to bisect");
    await bisect(route, opts.since, opts.minRatio, opts.json);
    return;
  }

  let routes: Route[];
  if (opts.adHoc) routes = [opts.adHoc];
  else if (opts.all) routes = loadRoutes();
  else if (opts.id) routes = [findRoute(opts.id)];
  else {
    throw new Error(
      "usage: evmsec solvency <route-id> | --all | " +
        "--lock-chain <c> --escrow 0x.. --token 0x.. --mint-chain <c> --minted 0x.. " +
        "[--since <block|date>] [--watch [--interval 60] [--webhook URL]] [--min-ratio 100] [--json]",
    );
  }

  if (opts.watch) {
    await watch(routes, opts);
    return;
  }

  const results = await checkAll(routes);

  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else render(results, opts.minRatio);

  // Non-zero exit on a breach OR on a route we couldn't verify — in CI, an
  // unconfirmable backing check is itself a failure, not a pass.
  if (results.some((r) => isRouteFailing(r, opts.minRatio))) process.exitCode = 1;
}

/**
 * Check routes with bounded concurrency; isolate failures so one unreadable
 * route (bad RPC, renamed contract) can't abort the whole scan or mask the
 * others — it surfaces as an ERROR result instead.
 */
export function checkAll(routes: Route[]): Promise<SolvencyResult[]> {
  return mapWithConcurrency(routes, ROUTE_CONCURRENCY, (route) => checkRouteSafe(route));
}

// ── watch (continuous monitoring) ────────────────────────────────────────────

/**
 * Poll the routes on an interval and alert once per breach *transition*
 * (de-duped via computeTransitions), recovering quietly. Optional webhook POST.
 * Clean shutdown on SIGINT/SIGTERM.
 */
async function watch(routes: Route[], opts: Opts): Promise<void> {
  const intervalMs = Math.max(5, opts.intervalSec) * 1000;
  const state = new Map<string, boolean>();
  const ratios = new Map<string, number | null>();
  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.error(
    `watching ${routes.length} route(s) every ${opts.intervalSec}s ` +
      `(min-ratio ${opts.minRatio}%${opts.delta !== undefined ? `, delta ${opts.delta}pp` : ""})` +
      `${opts.webhook ? ", webhook on" : ""} — Ctrl-C to stop`,
  );

  while (!stop) {
    const results = await checkAll(routes);
    const byId = new Map(results.map((r) => [r.id, r]));

    const current = results.map((r) => ({ id: r.id, failing: isRouteFailing(r, opts.minRatio) }));
    const transitions = computeTransitions(state, current);
    for (const c of current) state.set(c.id, c.failing);
    for (const t of transitions) {
      const r = byId.get(t.id);
      if (r) await emitAlert(t.kind, r, opts);
    }

    // Degrade alerts: a sudden drop in backing, even while still above threshold.
    if (opts.delta !== undefined) {
      const degrades = computeDegrades(ratios, results, opts.delta);
      for (const d of degrades) {
        const r = byId.get(d.id);
        if (r) await emitDegrade(d.from, d.to, r, opts);
      }
    }
    for (const r of results) ratios.set(r.id, r.ratioPct);

    if (stop) break;
    await sleepInterruptible(intervalMs, () => stop);
  }

  console.error("\nstopped.");
}

async function emitDegrade(from: number, to: number, r: SolvencyResult, opts: Opts): Promise<void> {
  const at = new Date().toISOString();
  const drop = (from - to).toFixed(2);
  if (opts.json) {
    console.log(JSON.stringify({ event: "degrade", at, from, to, ...r }));
  } else {
    console.log(
      `📉 ${at}  DEGRADE    ${r.bridge} — ${r.asset} [${r.id}]  backing ${from.toFixed(2)}% → ${to.toFixed(2)}% (−${drop}pp)`,
    );
  }
  if (opts.webhook) await postWebhook(opts.webhook, { event: "degrade", at, from, to, ...r });
}

async function emitAlert(kind: "breach" | "recovery", r: SolvencyResult, opts: Opts): Promise<void> {
  const at = new Date().toISOString();
  const ratioStr = r.ratioPct === null ? "n/a" : `${r.ratioPct.toFixed(2)}%`;
  if (opts.json) {
    console.log(JSON.stringify({ event: kind, at, ...r }));
  } else if (kind === "breach") {
    const why = r.verdict === "ERROR" ? `  (ERROR: ${r.error})` : "";
    console.log(`🚨 ${at}  BREACH     ${r.bridge} — ${r.asset} [${r.id}]  backing ${ratioStr}${why}`);
  } else {
    console.log(`✅ ${at}  RECOVERED  ${r.bridge} — ${r.asset} [${r.id}]  backing ${ratioStr}`);
  }
  if (opts.webhook) await postWebhook(opts.webhook, { event: kind, at, ...r });
}

async function postWebhook(url: string, payload: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`  webhook POST failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Sleep `ms`, but wake early (within ~250ms) when `stopped()` flips — keeps Ctrl-C snappy. */
async function sleepInterruptible(ms: number, stopped: () => boolean): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < ms && !stopped(); waited += step) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
}

/** checkRoute, but a thrown read becomes an ERROR result rather than aborting `--all`. */
async function checkRouteSafe(route: Route): Promise<SolvencyResult> {
  try {
    return await checkRoute(route);
  } catch (err) {
    return {
      id: route.id,
      bridge: route.bridge,
      asset: route.asset,
      lockChain: [...new Set(lockLegs(route).map((l) => l.chain))].join(" + "),
      mintChain: route.mint.chain,
      locked: "—",
      minted: "—",
      ratioPct: null,
      delta: "—",
      verdict: "ERROR",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── measurement ─────────────────────────────────────────────────────────────

/** One resolved lock leg: a token + escrow on some chain, with cached decimals. */
interface LegCtx {
  chain: ChainConfig;
  token: Contract;
  escrow: string;
  dec: number;
}

interface RouteCtx {
  route: Route;
  legs: LegCtx[];
  mintChain: ChainConfig;
  mintToken: Contract;
  mintDec: number;
}

/** Resolve contracts + decimals once so historical probes don't refetch them. */
async function loadCtx(route: Route): Promise<RouteCtx> {
  const mintChain = chain(route.mint.chain);
  const mintToken = new Contract(requireAddress(route.mint.token, "mint token"), ERC20_ABI, getProvider(mintChain));

  const legs = await Promise.all(
    lockLegs(route).map(async (leg): Promise<LegCtx> => {
      const legChain = chain(leg.chain);
      const token = new Contract(requireAddress(leg.token, "lock token"), ERC20_ABI, getProvider(legChain));
      const dec = await withRetry(() => token.decimals(), { label: "lock decimals" }).then(Number);
      return { chain: legChain, token, escrow: requireAddress(leg.escrow, "escrow"), dec };
    }),
  );
  const mintDec = await withRetry(() => mintToken.decimals(), { label: "mint decimals" }).then(Number);

  return { route, legs, mintChain, mintToken, mintDec };
}

interface Measurement {
  mintedRaw: bigint;
  locked18: bigint;
  minted18: bigint;
  mintBlock: number;
  ts: number;
  /** per-leg lock block, aligned to the mint block's timestamp. */
  legBlocks: number[];
}

/**
 * Measure the invariant as of destination-chain block `mintBlock` (or latest),
 * aligning each lock chain to that block's wall-clock timestamp and summing the
 * legs (multi-asset / multi-escrow routes) into a common 18-dp fixed point.
 */
async function measure(ctx: RouteCtx, mintBlock?: number): Promise<Measurement> {
  const mintProvider = getProvider(ctx.mintChain);
  const resolvedMintBlock = mintBlock ?? (await withRetry(() => mintProvider.getBlockNumber(), { label: "mint head" }));
  const ts = (await getBlockCached(mintProvider, ctx.mintChain.key, resolvedMintBlock)).timestamp;

  const [legResults, mintedRaw] = await Promise.all([
    Promise.all(
      ctx.legs.map(async (leg) => {
        const lockBlock = await blockAtOrBefore(getProvider(leg.chain), leg.chain.key, ts);
        const raw = (await withRetry(() => leg.token.balanceOf(leg.escrow, { blockTag: lockBlock }), {
          label: "balanceOf",
        })) as bigint;
        return { lockBlock, raw, dec: leg.dec };
      }),
    ),
    withRetry(() => ctx.mintToken.totalSupply({ blockTag: resolvedMintBlock }), {
      label: "totalSupply",
    }) as Promise<bigint>,
  ]);

  return {
    mintedRaw,
    locked18: sumLocked18(legResults.map((l) => ({ raw: l.raw, decimals: l.dec }))),
    minted18: to18(mintedRaw, ctx.mintDec),
    mintBlock: resolvedMintBlock,
    ts,
    legBlocks: legResults.map((l) => l.lockBlock),
  };
}

/** Distinct lock-chain display name(s) for a route context. */
function lockChainLabel(ctx: RouteCtx): string {
  const names = [...new Set(ctx.legs.map((l) => l.chain.name))];
  return names.join(" + ");
}

function isBreach(m: Measurement, minRatio: number): boolean {
  return isUnderBacked(m.locked18, m.minted18, minRatio);
}

// ── USD valuation (best-effort, Chainlink on-chain) ─────────────────────────

/** Per-run cache so shared feeds (WBTC×3, DAI×3…) are read once, not per route. */
const feedCache = new Map<string, Promise<HopReading>>();

function readFeed(address: string): Promise<HopReading> {
  let p = feedCache.get(address);
  if (!p) {
    const agg = new Contract(address, AGGREGATOR_ABI, getProvider(chain("ethereum")));
    p = (async (): Promise<HopReading> => {
      const [rd, dec] = await Promise.all([
        withRetry(() => agg.latestRoundData(), { label: "latestRoundData" }) as Promise<[bigint, bigint]>,
        withRetry(() => agg.decimals(), { label: "feed decimals" }).then(Number),
      ]);
      return { answer: rd[1], decimals: dec };
    })();
    feedCache.set(address, p);
  }
  return p;
}

/** Value a route's locked/minted amounts in USD, or return undefined if we can't. */
async function priceRoute(
  asset: string,
  locked18: bigint,
  minted18: bigint,
): Promise<Pick<SolvencyResult, "priceUsd" | "lockedUsd" | "mintedUsd" | "deltaUsd" | "pricedVia"> | undefined> {
  const route = priceRouteFor(asset);
  if (!route) return undefined;
  try {
    const readings = await Promise.all(route.hops.map((h) => readFeed(h.address)));
    const price = priceFromHops(readings);
    if (price === null) return undefined;
    const lockedUsd = usdValue(locked18, price);
    const mintedUsd = usdValue(minted18, price);
    return {
      priceUsd: price,
      lockedUsd,
      mintedUsd,
      deltaUsd: lockedUsd - mintedUsd,
      pricedVia: route.hops.map((h) => h.pair).join(" × "),
    };
  } catch {
    return undefined; // a price hiccup must never mask the backing verdict
  }
}

// ── point-in-time check ─────────────────────────────────────────────────────

async function checkRoute(route: Route): Promise<SolvencyResult> {
  const ctx = await loadCtx(route);
  const m = await measure(ctx);

  let ratioPct: number | null;
  let verdict: SolvencyResult["verdict"];
  if (m.minted18 === 0n) {
    ratioPct = null;
    verdict = "NO_SUPPLY";
  } else {
    ratioPct = backingPct(m.locked18, m.minted18);
    verdict = m.locked18 >= m.minted18 ? "BACKED" : "UNDERCOLLATERALIZED";
  }

  const d = m.locked18 - m.minted18;
  const usd = await priceRoute(route.asset, m.locked18, m.minted18);
  return {
    id: route.id,
    bridge: route.bridge,
    asset: route.asset,
    lockChain: lockChainLabel(ctx),
    mintChain: ctx.mintChain.name,
    locked: formatUnits(m.locked18, 18),
    minted: formatUnits(m.mintedRaw, ctx.mintDec),
    ratioPct,
    delta: `${d >= 0n ? "+" : "-"}${formatUnits(d < 0n ? -d : d, 18)}`,
    verdict,
    ...usd,
  };
}

// ── forensic bisection ──────────────────────────────────────────────────────

async function bisect(route: Route, since: string, minRatio: number, json: boolean): Promise<void> {
  const ctx = await loadCtx(route);
  const mintProvider = getProvider(ctx.mintChain);
  const latest = await mintProvider.getBlockNumber();
  const start = await resolveSince(ctx, since, latest);
  if (start >= latest) throw new Error(`--since (${start}) is at/after head (${latest}) on ${ctx.mintChain.name}`);

  // Endpoints define the search: expect healthy at `start`, breached at head.
  let startM: Measurement;
  let headM: Measurement;
  try {
    [startM, headM] = await Promise.all([measure(ctx, start), measure(ctx, latest)]);
  } catch (e) {
    const envs = [...new Set([...ctx.legs.map((l) => l.chain.key), ctx.mintChain.key])].map(envName).join(" / ");
    throw new Error(
      `historical state read failed (${e instanceof Error ? e.message : e}). ` +
        `--since needs an archive RPC — set ${envs} to an archive node.`,
      { cause: e },
    );
  }

  if (isBreach(startM, minRatio)) {
    if (json)
      console.log(
        JSON.stringify(
          { result: "already-breached-at-start", route: route.id, startBlock: start, ...fmt(ctx, startM) },
          null,
          2,
        ),
      );
    else {
      console.log(`\n⚠ Already undercollateralized at --since block ${start} (${iso(startM.ts)}).`);
      console.log(`  backing ${ratio(startM)} — move --since earlier to find the true onset.\n`);
    }
    process.exitCode = 1;
    return;
  }
  if (!isBreach(headM, minRatio)) {
    if (json)
      console.log(
        JSON.stringify({ result: "healthy", route: route.id, window: [start, latest], ...fmt(ctx, headM) }, null, 2),
      );
    else {
      console.log(`\n✓ Backing held ≥ ${minRatio}% across the whole window [${start}, ${latest}].`);
      console.log(`  current backing ${ratio(headM)}. No breach to locate.\n`);
    }
    return;
  }

  // Invariant: healthy at `start`, breached at head. Converge to the boundary.
  const {
    lastHealthy: lo,
    firstBroken: hi,
    probes,
  } = await firstBreachBlock(start, latest, async (n) => {
    const m = await measure(ctx, n);
    return isUnderBacked(m.locked18, m.minted18, minRatio);
  });

  const lastHealthy = await measure(ctx, lo);
  const firstBroken = await measure(ctx, hi);
  const culprits = await mintTransfersIn(ctx, hi);

  if (json) {
    console.log(
      JSON.stringify(
        {
          result: "breach-located",
          route: route.id,
          probes,
          lastHealthy: { block: lo, ts: lastHealthy.ts, ...fmt(ctx, lastHealthy) },
          firstBroken: { block: hi, ts: firstBroken.ts, ...fmt(ctx, firstBroken) },
          candidateTxs: culprits,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n🔎 Backing breach located for ${route.bridge} — ${route.asset} [${route.id}]`);
  console.log("─".repeat(68));
  console.log(`  last healthy   ${ctx.mintChain.name} block ${lo}  (${iso(lastHealthy.ts)})`);
  console.log(
    `                 backing ${ratio(lastHealthy)}   locked ${flock(lastHealthy)}  minted ${fmint(ctx, lastHealthy.mintedRaw)}`,
  );
  console.log(`  first breached ${ctx.mintChain.name} block ${hi}  (${iso(firstBroken.ts)})`);
  console.log(
    `                 backing ${ratio(firstBroken)}   locked ${flock(firstBroken)}  minted ${fmint(ctx, firstBroken.mintedRaw)}`,
  );
  console.log(`  located in     ${probes} probes  ·  ${blockLink(ctx.mintChain, hi)}`);
  if (culprits.length) {
    console.log(`\n  candidate cause — mint-token transfers in block ${hi}:`);
    for (const c of culprits) {
      const tag = c.from === ZERO ? "MINT" : "xfer";
      console.log(`    ${tag}  ${shortAddr(c.from)} → ${shortAddr(c.to)}  ${c.amount}   tx ${c.tx}`);
    }
  }
  console.log();
  process.exitCode = 1;
}

const ZERO = "0x0000000000000000000000000000000000000000";

interface Transfer {
  from: string;
  to: string;
  amount: string;
  tx: string;
}

/** Best-effort: mint-token Transfer events in the boundary block, mints first. */
async function mintTransfersIn(ctx: RouteCtx, block: number): Promise<Transfer[]> {
  try {
    const logs = await ctx.mintToken.queryFilter(ctx.mintToken.filters.Transfer(), block, block);
    return logs
      .map((l): Transfer => {
        const ev = l as unknown as { args: { from: string; to: string; value: bigint }; transactionHash: string };
        return {
          from: ev.args.from,
          to: ev.args.to,
          amount: formatUnits(ev.args.value, ctx.mintDec),
          tx: ev.transactionHash,
        };
      })
      .sort((a, b) => Number(b.from === ZERO) - Number(a.from === ZERO));
  } catch {
    return [];
  }
}

/** Resolve `--since` as a destination-chain block number, a unix ts, or an ISO date. */
async function resolveSince(ctx: RouteCtx, since: string, latest: number): Promise<number> {
  const asNum = Number(since);
  if (Number.isInteger(asNum) && asNum > 0 && asNum <= latest) return asNum; // block number
  const ts = Number.isFinite(asNum) && asNum > 1_000_000_000 ? asNum : Math.floor(new Date(since).getTime() / 1000);
  if (!Number.isFinite(ts) || ts <= 0)
    throw new Error(`could not parse --since "${since}" (use a block number, unix ts, or ISO date)`);
  return blockAtOrBefore(getProvider(ctx.mintChain), ctx.mintChain.key, ts);
}

// ── formatting ──────────────────────────────────────────────────────────────

function ratio(m: Measurement): string {
  const pct = backingPct(m.locked18, m.minted18);
  return pct === null ? "n/a" : `${pct.toFixed(2)}%`;
}
/** Locked is summed across legs into 18 dp; format it at 18 dp. */
function flock(m: Measurement): string {
  return formatUnits(m.locked18, 18);
}
function fmint(ctx: RouteCtx, raw: bigint): string {
  return formatUnits(raw, ctx.mintDec);
}
function fmt(ctx: RouteCtx, m: Measurement) {
  return { backing: ratio(m), locked: flock(m), minted: fmint(ctx, m.mintedRaw) };
}
function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}
function envName(key: string): string {
  return `${key.toUpperCase().replace(/-/g, "_")}_RPC_URL`;
}

function render(results: SolvencyResult[], minRatio: number): void {
  for (const r of results) {
    if (r.verdict === "ERROR") {
      console.log(`\n✗ ${r.bridge} — ${r.asset}  [${r.id}]`);
      console.log("─".repeat(64));
      console.log(`  verdict  ERROR — could not verify backing`);
      console.log(`           ${r.error}`);
      continue;
    }
    const mark = r.verdict === "BACKED" && (r.ratioPct ?? 0) >= minRatio ? "✓" : r.verdict === "NO_SUPPLY" ? "·" : "✗";
    const ratioStr = r.ratioPct === null ? "n/a" : `${r.ratioPct.toFixed(2)}%`;
    console.log(`\n${mark} ${r.bridge} — ${r.asset}  [${r.id}]`);
    console.log("─".repeat(64));
    console.log(`  locked   ${r.locked}  (${r.lockChain})`);
    console.log(`  minted   ${r.minted}  (${r.mintChain})`);
    console.log(`  backing  ${ratioStr}    delta ${r.delta}`);
    if (r.lockedUsd != null) {
      const deficit =
        r.verdict === "UNDERCOLLATERALIZED" && r.deltaUsd != null ? `   deficit ${fmtUsd(r.deltaUsd)}` : "";
      console.log(
        `  value    ${fmtUsd(r.lockedUsd)} locked  ·  ${fmtUsd(r.mintedUsd ?? 0)} minted${deficit}  [${r.pricedVia}]`,
      );
    }
    console.log(
      `  verdict  ${r.verdict}${r.verdict === "UNDERCOLLATERALIZED" ? "  ⚠ bridge is printing unbacked supply" : ""}`,
    );
  }
  console.log();
}

// ── arg parsing ─────────────────────────────────────────────────────────────

interface Opts {
  id?: string;
  all: boolean;
  json: boolean;
  minRatio: number;
  since?: string;
  watch: boolean;
  intervalSec: number;
  webhook?: string;
  delta?: number;
  adHoc?: Route;
}

function parse(args: string[]): Opts {
  const opts: Opts = { all: false, json: false, minRatio: 100, watch: false, intervalSec: 60 };
  const adHoc: Partial<{ lockChain: string; escrow: string; token: string; mintChain: string; minted: string }> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--all":
        opts.all = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--min-ratio":
        opts.minRatio = Number(args[++i]);
        break;
      case "--since":
        opts.since = args[++i];
        break;
      case "--watch":
        opts.watch = true;
        break;
      case "--interval":
        opts.intervalSec = Number(args[++i]);
        break;
      case "--webhook":
        opts.webhook = args[++i];
        break;
      case "--delta":
        opts.delta = Number(args[++i]);
        break;
      case "--lock-chain":
        adHoc.lockChain = args[++i];
        break;
      case "--escrow":
        adHoc.escrow = args[++i];
        break;
      case "--token":
        adHoc.token = args[++i];
        break;
      case "--mint-chain":
        adHoc.mintChain = args[++i];
        break;
      case "--minted":
        adHoc.minted = args[++i];
        break;
      default:
        if (!a.startsWith("-") && !opts.id) opts.id = a;
    }
  }

  if (adHoc.lockChain || adHoc.escrow || adHoc.token || adHoc.mintChain || adHoc.minted) {
    const missing = (["lockChain", "escrow", "token", "mintChain", "minted"] as const).filter((k) => !adHoc[k]);
    if (missing.length)
      throw new Error(`ad-hoc route missing: ${missing.map((m) => "--" + m.replace("Chain", "-chain")).join(", ")}`);
    opts.adHoc = {
      id: "ad-hoc",
      bridge: "ad-hoc route",
      asset: "asset",
      lock: { chain: adHoc.lockChain as LockLeg["chain"], escrow: adHoc.escrow!, token: adHoc.token! },
      mint: { chain: adHoc.mintChain as Route["mint"]["chain"], token: adHoc.minted! },
    };
  }

  return opts;
}
