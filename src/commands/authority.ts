import { readFileSync, writeFileSync } from "node:fs";
import { chain } from "../config.js";
import { findRoute, lockLegs, Route } from "../bridges.js";
import { getProvider, mapWithConcurrency } from "../lib.js";
import { captureAuthoritySnapshot, resolveAuthority } from "../checks/onchain.js";
import {
  AuthoritySnapshot,
  BaselineFile,
  Drift,
  computeAuthorityTransitions,
  diffBaselines,
  mergeSnapshots,
  parseBaselineFile,
  renderAuthorityHuman,
  renderAuthorityJson,
  snapshotKey,
} from "../authority-watch-core.js";

const USAGE = `usage:
  evmsec authority snapshot --route <route-id> [--out baseline.json] [--append]
  evmsec authority snapshot --address 0x.. [--address 0x..] [--chain ethereum] [--label "..."] [--out baseline.json] [--append]
  evmsec authority check --baseline baseline.json [--json]
  evmsec authority watch --baseline baseline.json [--interval 300] [--webhook URL] [--json]`;

const CONCURRENCY = Math.max(1, Number(process.env.EVMSEC_CONCURRENCY ?? 5));

/**
 * `evmsec authority` — signer-set drift monitoring. Snapshot the
 * authority-relevant state of bridge infrastructure (Safe owners/threshold/
 * modules, timelock delays, 7702 delegations, codehashes) into a committed
 * baseline file, then `check` (CI: exit non-zero on drift) or `watch`
 * (alert once per drift/recovery transition, optional webhook).
 */
export async function authority(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "snapshot") return snapshot(rest);
  if (sub === "check") return check(rest);
  if (sub === "watch") return watch(rest);
  throw new Error(USAGE);
}

// ── snapshot ─────────────────────────────────────────────────────────────

interface SnapshotOpts {
  addresses: string[];
  chainKey: string;
  routeId?: string;
  label?: string;
  out: string;
  append: boolean;
}

function parseSnapshot(args: string[]): SnapshotOpts {
  const o: SnapshotOpts = { addresses: [], chainKey: "ethereum", out: "authority-baseline.json", append: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--address") o.addresses.push(args[++i]);
    else if (a === "--chain") o.chainKey = args[++i];
    else if (a === "--route") o.routeId = args[++i];
    else if (a === "--label") o.label = args[++i];
    else if (a === "--out") o.out = args[++i];
    else if (a === "--append") o.append = true;
    else throw new Error(`unknown flag ${a}\n${USAGE}`);
  }
  if (!o.routeId && o.addresses.length === 0) throw new Error(`snapshot needs --route or --address\n${USAGE}`);
  return o;
}

/** Capture the current state of every baseline entry (parallel, order-stable). */
async function captureAll(
  entries: Array<Pick<AuthoritySnapshot, "address" | "chain" | "label">>,
): Promise<AuthoritySnapshot[]> {
  return mapWithConcurrency(entries, CONCURRENCY, async (e) => {
    const c = chain(e.chain);
    return captureAuthoritySnapshot(getProvider(c), c.key, e.address, e.label);
  });
}

async function snapshotRoute(route: Route): Promise<AuthoritySnapshot[]> {
  const seen = new Map<string, AuthoritySnapshot>();
  const put = (s: AuthoritySnapshot): void => {
    if (!seen.has(snapshotKey(s))) seen.set(snapshotKey(s), s);
  };
  const jobs: Array<{ chainKey: string; address: string; label: string; guards?: string }> = [];
  for (const leg of lockLegs(route)) {
    const label = `${route.bridge} ${route.asset} escrow (${leg.chain})`;
    jobs.push({ chainKey: leg.chain, address: leg.escrow, label });
  }
  const mintLabel = `${route.bridge} ${route.asset} wrapped token (${route.mint.chain})`;
  jobs.push({ chainKey: route.mint.chain, address: route.mint.token, label: mintLabel });

  // Capture the contracts first (codehash catches proxy upgrades), then resolve
  // each contract's authority and capture *it* — the signer set is the asset.
  const contracts = await mapWithConcurrency(jobs, CONCURRENCY, async (j) => {
    const c = chain(j.chainKey);
    const s = await captureAuthoritySnapshot(getProvider(c), c.key, j.address, j.label);
    return { job: j, snapshot: s };
  });
  for (const { snapshot } of contracts) put(snapshot);

  const authorities = await mapWithConcurrency(contracts, CONCURRENCY, async ({ job, snapshot }) => {
    const c = chain(job.chainKey);
    const provider = getProvider(c);
    let authAddr: string | null;
    try {
      authAddr = await resolveAuthority(provider, snapshot.address);
    } catch {
      authAddr = null;
    }
    if (!authAddr || authAddr.toLowerCase() === snapshot.address.toLowerCase()) return null;
    return captureAuthoritySnapshot(provider, c.key, authAddr, `${job.label} authority`, job.label);
  });
  for (const s of authorities) if (s) put(s);
  return [...seen.values()];
}

async function snapshot(args: string[]): Promise<void> {
  const o = parseSnapshot(args);
  let incoming: AuthoritySnapshot[];
  if (o.routeId) {
    const route = findRoute(o.routeId);
    console.error(`resolving authorities for route ${route.id} (${route.bridge} ${route.asset})…`);
    incoming = await snapshotRoute(route);
  } else {
    const c = chain(o.chainKey);
    incoming = await mapWithConcurrency(o.addresses, CONCURRENCY, async (a, i) => {
      const label = o.label ?? (o.addresses.length === 1 ? `${a} (${c.key})` : `${a} (${c.key}) #${i + 1}`);
      return captureAuthoritySnapshot(getProvider(c), c.key, a, label);
    });
  }

  let baseline: BaselineFile = { version: 1, snapshots: [] };
  if (o.append) {
    try {
      baseline = parseBaselineFile(readFileSync(o.out, "utf8"), o.out);
    } catch (e) {
      if (!(e instanceof Error && /ENOENT/.test(e.message))) throw e;
    }
  }
  baseline = mergeSnapshots(baseline, incoming);
  writeFileSync(o.out, JSON.stringify(baseline, null, 2) + "\n");
  for (const s of incoming) {
    console.error(
      `  ${s.kind.padEnd(9)} ${s.address} (${s.chain}) — ${s.label}` +
        (s.kind === "safe" ? ` — ${s.threshold}-of-${s.owners?.length}` : ""),
    );
  }
  console.error(`wrote ${incoming.length} snapshot(s) → ${o.out}`);
}

// ── check ────────────────────────────────────────────────────────────────

function loadBaseline(path: string): BaselineFile {
  return parseBaselineFile(readFileSync(path, "utf8"), path);
}

async function check(args: string[]): Promise<void> {
  let baselinePath = "";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--baseline") baselinePath = args[++i];
    else if (a === "--json") json = true;
    else throw new Error(`unknown flag ${a}\n${USAGE}`);
  }
  if (!baselinePath) throw new Error(`check needs --baseline\n${USAGE}`);

  const baseline = loadBaseline(baselinePath);
  const current = await captureAll(baseline.snapshots);
  const drifts = diffBaselines(baseline, current);

  if (json) console.log(renderAuthorityJson(baseline, drifts));
  else console.log(renderAuthorityHuman(baseline, drifts));
  if (drifts.length > 0) process.exitCode = 1;
}

// ── watch ────────────────────────────────────────────────────────────────

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

function sleepInterruptible(ms: number, stopped: () => boolean): Promise<void> {
  const step = 250;
  return (async () => {
    for (let waited = 0; waited < ms && !stopped(); waited += step) {
      await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
    }
  })();
}

async function watch(args: string[]): Promise<void> {
  let baselinePath = "";
  let intervalSec = 300;
  let webhook: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--baseline") baselinePath = args[++i];
    else if (a === "--interval") {
      intervalSec = Number(args[++i]);
      if (!Number.isFinite(intervalSec) || intervalSec < 5) throw new Error("--interval needs ≥ 5 seconds");
    } else if (a === "--webhook") webhook = args[++i];
    else if (a === "--json") json = true;
    else throw new Error(`unknown flag ${a}\n${USAGE}`);
  }
  if (!baselinePath) throw new Error(`watch needs --baseline\n${USAGE}`);

  const baseline = loadBaseline(baselinePath);
  const state = new Map<string, boolean>(); // key → currently drifted
  let stop = false;
  const onSignal = (): void => {
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.error(
    `watching ${baseline.snapshots.length} address(es) every ${intervalSec}s from ${baselinePath}` +
      `${webhook ? ", webhook on" : ""} — Ctrl-C to stop`,
  );

  const at = (): string => new Date().toISOString();
  while (!stop) {
    const current = await captureAll(baseline.snapshots);
    const drifts = diffBaselines(baseline, current);
    const byKey = new Map<string, Drift[]>();
    for (const d of drifts) {
      const key = `${d.chain}:${d.address.toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(d);
    }
    // Keys with no drift still participate so recoveries are detected.
    for (const s of baseline.snapshots) {
      const key = snapshotKey(s);
      if (!byKey.has(key)) byKey.set(key, []);
    }
    const transitions = computeAuthorityTransitions(state, byKey);
    for (const [key, ds] of byKey) state.set(key, ds.length > 0);

    for (const t of transitions) {
      const [tChain, tAddr] = [t.key.split(":")[0], t.key.split(":").slice(1).join(":")];
      const label = baseline.snapshots.find((s) => snapshotKey(s) === t.key)?.label ?? t.key;
      if (json) {
        console.log(
          JSON.stringify({
            tool: "evmsec",
            event: `authority-${t.kind}`,
            at: at(),
            chain: tChain,
            address: tAddr,
            label,
            drifts: t.drifts,
          }),
        );
      } else if (t.kind === "drift") {
        console.log(`🚨 ${at()}  DRIFT      ${label} — ${tAddr} (${tChain})`);
        for (const d of t.drifts) console.log(`    ${d.field.padEnd(12)} ${d.before}  →  ${d.after}`);
      } else {
        console.log(`✅ ${at()}  RECOVERED  ${label} — ${tAddr} (${tChain}) back at baseline`);
      }
      if (webhook)
        await postWebhook(webhook, {
          tool: "evmsec",
          event: `authority-${t.kind}`,
          at: at(),
          chain: tChain,
          address: tAddr,
          label,
          drifts: t.drifts,
        });
    }

    if (stop) break;
    await sleepInterruptible(intervalSec * 1000, () => stop);
  }
  console.error("\nstopped.");
}
