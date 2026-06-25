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
  requireAddress,
  shortAddr,
  to18,
} from "../lib.js";
import { Route, loadRoutes, findRoute } from "../bridges.js";

interface SolvencyResult {
  id: string;
  bridge: string;
  asset: string;
  lockChain: string;
  mintChain: string;
  locked: string;
  minted: string;
  ratioPct: number | null;
  delta: string;
  verdict: "BACKED" | "UNDERCOLLATERALIZED" | "NO_SUPPLY";
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
        "[--since <block|date>] [--min-ratio 100] [--json]",
    );
  }

  const results: SolvencyResult[] = [];
  for (const route of routes) results.push(await checkRoute(route));

  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else render(results, opts.minRatio);

  const breached = results.some(
    (r) => r.verdict === "UNDERCOLLATERALIZED" || (r.ratioPct !== null && r.ratioPct < opts.minRatio),
  );
  if (breached) process.exitCode = 1;
}

// ── measurement ─────────────────────────────────────────────────────────────

interface RouteCtx {
  route: Route;
  lockChain: ChainConfig;
  mintChain: ChainConfig;
  lockToken: Contract;
  mintToken: Contract;
  escrow: string;
  lockDec: number;
  mintDec: number;
}

/** Resolve contracts + decimals once so historical probes don't refetch them. */
async function loadCtx(route: Route): Promise<RouteCtx> {
  const lockChain = chain(route.lock.chain);
  const mintChain = chain(route.mint.chain);
  const lockToken = new Contract(requireAddress(route.lock.token, "lock token"), ERC20_ABI, getProvider(lockChain));
  const mintToken = new Contract(requireAddress(route.mint.token, "mint token"), ERC20_ABI, getProvider(mintChain));
  const [lockDec, mintDec] = await Promise.all([
    lockToken.decimals().then(Number) as Promise<number>,
    mintToken.decimals().then(Number) as Promise<number>,
  ]);
  return {
    route,
    lockChain,
    mintChain,
    lockToken,
    mintToken,
    escrow: requireAddress(route.lock.escrow, "escrow"),
    lockDec,
    mintDec,
  };
}

interface Measurement {
  lockedRaw: bigint;
  mintedRaw: bigint;
  locked18: bigint;
  minted18: bigint;
  mintBlock: number;
  lockBlock: number;
  ts: number;
}

/**
 * Measure the invariant as of destination-chain block `mintBlock` (or latest),
 * aligning the source chain to that block's wall-clock timestamp.
 */
async function measure(ctx: RouteCtx, mintBlock?: number): Promise<Measurement> {
  const mintProvider = getProvider(ctx.mintChain);
  const resolvedMintBlock = mintBlock ?? (await mintProvider.getBlockNumber());
  const ts = (await getBlockCached(mintProvider, ctx.mintChain.key, resolvedMintBlock)).timestamp;
  const lockBlock = await blockAtOrBefore(getProvider(ctx.lockChain), ctx.lockChain.key, ts);

  const [lockedRaw, mintedRaw] = await Promise.all([
    ctx.lockToken.balanceOf(ctx.escrow, { blockTag: lockBlock }) as Promise<bigint>,
    ctx.mintToken.totalSupply({ blockTag: resolvedMintBlock }) as Promise<bigint>,
  ]);

  return {
    lockedRaw,
    mintedRaw,
    locked18: to18(lockedRaw, ctx.lockDec),
    minted18: to18(mintedRaw, ctx.mintDec),
    mintBlock: resolvedMintBlock,
    lockBlock,
    ts,
  };
}

function isBreach(m: Measurement, minRatio: number): boolean {
  return isUnderBacked(m.locked18, m.minted18, minRatio);
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
  return {
    id: route.id,
    bridge: route.bridge,
    asset: route.asset,
    lockChain: ctx.lockChain.name,
    mintChain: ctx.mintChain.name,
    locked: formatUnits(m.lockedRaw, ctx.lockDec),
    minted: formatUnits(m.mintedRaw, ctx.mintDec),
    ratioPct,
    delta: `${d >= 0n ? "+" : "-"}${formatUnits(d < 0n ? -d : d, 18)}`,
    verdict,
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
    throw new Error(
      `historical state read failed (${e instanceof Error ? e.message : e}). ` +
        `--since needs an archive RPC — set ${envName(ctx.lockChain.key)} / ${envName(ctx.mintChain.key)} to an archive node.`,
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
    `                 backing ${ratio(lastHealthy)}   locked ${fnum(ctx, lastHealthy.lockedRaw, "lock")}  minted ${fnum(ctx, lastHealthy.mintedRaw, "mint")}`,
  );
  console.log(`  first breached ${ctx.mintChain.name} block ${hi}  (${iso(firstBroken.ts)})`);
  console.log(
    `                 backing ${ratio(firstBroken)}   locked ${fnum(ctx, firstBroken.lockedRaw, "lock")}  minted ${fnum(ctx, firstBroken.mintedRaw, "mint")}`,
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
function fnum(ctx: RouteCtx, raw: bigint, side: "lock" | "mint"): string {
  return formatUnits(raw, side === "lock" ? ctx.lockDec : ctx.mintDec);
}
function fmt(ctx: RouteCtx, m: Measurement) {
  return { backing: ratio(m), locked: fnum(ctx, m.lockedRaw, "lock"), minted: fnum(ctx, m.mintedRaw, "mint") };
}
function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}
function envName(key: string): string {
  return `${key.toUpperCase().replace(/-/g, "_")}_RPC_URL`;
}

function render(results: SolvencyResult[], minRatio: number): void {
  for (const r of results) {
    const mark = r.verdict === "BACKED" && (r.ratioPct ?? 0) >= minRatio ? "✓" : r.verdict === "NO_SUPPLY" ? "·" : "✗";
    const ratioStr = r.ratioPct === null ? "n/a" : `${r.ratioPct.toFixed(2)}%`;
    console.log(`\n${mark} ${r.bridge} — ${r.asset}  [${r.id}]`);
    console.log("─".repeat(64));
    console.log(`  locked   ${r.locked}  (${r.lockChain})`);
    console.log(`  minted   ${r.minted}  (${r.mintChain})`);
    console.log(`  backing  ${ratioStr}    delta ${r.delta}`);
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
  adHoc?: Route;
}

function parse(args: string[]): Opts {
  const opts: Opts = { all: false, json: false, minRatio: 100 };
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
      lock: { chain: adHoc.lockChain as Route["lock"]["chain"], escrow: adHoc.escrow!, token: adHoc.token! },
      mint: { chain: adHoc.mintChain as Route["mint"]["chain"], token: adHoc.minted! },
    };
  }

  return opts;
}
