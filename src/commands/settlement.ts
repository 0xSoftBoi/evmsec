import { Contract, formatUnits } from "ethers";
import { ChainConfig, chain, chainById } from "../config.js";
import { ERC20_ABI, getBlockCached, getProvider, shortAddr, txLink, withRetry } from "../lib.js";
import { ExpectedOutput, classify, matchDelivery } from "../settlement-core.js";
import { DEFAULT_PROTOCOL, NormalizedOrder, getProtocol } from "../protocols/index.js";
import { FillCandidate, chunkRange, selectFillTx } from "../discovery-core.js";

/** getLogs sub-range size for fill scanning (override via EVMSEC_SCAN_CHUNK). */
const SCAN_CHUNK = Number(process.env.EVMSEC_SCAN_CHUNK) || 10_000;

/**
 * `evmsec settlement --source-chain <c> --intent-tx <openTx> --fill-tx <fillTx>`
 *
 * Verifies a cross-chain intent was actually fulfilled: decodes the intent on
 * the source chain (which protocol via `--protocol`, default ERC-7683) to learn
 * what the filler promised to deliver, then checks the destination `fill` tx
 * really delivered that token/amount to the intended recipient, before the
 * deadline, and final.
 */
export async function settlement(args: string[]): Promise<void> {
  const o = parse(args);
  if (!o.sourceChain || !o.intentTx) {
    throw new Error(
      "usage: evmsec settlement --source-chain <c> --intent-tx <openTx> [--fill-tx <fillTx>] " +
        "[--protocol erc7683|across|cow] [--dest-chain <c>] [--scan-blocks 50000] [--finality-depth 12] [--json]\n" +
        "(omit --fill-tx to auto-discover it on the destination; for CoW pass the settlement tx as --intent-tx)",
    );
  }

  const proto = getProtocol(o.protocol ?? DEFAULT_PROTOCOL);
  const src = chain(o.sourceChain);

  const intentReceipt = await withRetry(() => getProvider(src).getTransactionReceipt(o.intentTx!), {
    label: "intent receipt",
  });
  if (!intentReceipt) throw new Error(`intent tx not found on ${src.name}: ${o.intentTx}`);
  const order = proto.parseIntent(intentReceipt.logs, { srcChainId: src.chainId });
  if (!order) {
    throw new Error(`no ${proto.label} intent event in ${o.intentTx} on ${src.name} — is this the order-opening tx?`);
  }

  const outputs = order.outputs;
  if (outputs.length === 0) throw new Error("intent has no outputs to verify");

  const destChain = resolveDestChain(o.destChain, outputs);
  const destProvider = getProvider(destChain);
  const onDest = outputs.filter((x) => x.chainId === destChain.chainId);

  // Auto-discover the fill tx on the destination when the user didn't supply one.
  let fillTx = o.fillTx;
  if (!fillTx) {
    if (!o.json)
      console.error(`no --fill-tx — scanning the last ${o.scanBlocks} ${destChain.name} blocks for the fill…`);
    fillTx = await discoverFillTx(destChain, onDest, o.scanBlocks);
    if (!o.json) console.error(`discovered fill tx ${fillTx}`);
  }

  const fillReceipt = await withRetry(() => destProvider.getTransactionReceipt(fillTx!), { label: "fill receipt" });
  if (!fillReceipt) throw new Error(`fill tx not found on ${destChain.name}: ${fillTx}`);
  const transfers = proto.parseFill(fillReceipt.logs);
  const fillBlock = fillReceipt.blockNumber;
  const [fillTs, destHead] = await Promise.all([
    getBlockCached(destProvider, destChain.key, fillBlock).then((b) => b.timestamp),
    withRetry(() => destProvider.getBlockNumber(), { label: "dest head" }),
  ]);
  const finalized = destHead - fillBlock >= o.finalityDepth;
  const fillDeadline = order.fillDeadline;
  const deadlineMet = fillDeadline === 0 || fillTs <= fillDeadline;

  const decimalsCache = new Map<string, number>();

  const results: OutResult[] = [];
  for (const out of onDest) {
    if (out.native) {
      results.push({
        out,
        native: true,
        verdict: {
          status: "anomaly",
          anomalies: [],
          warnings: ["native-token output — not verifiable from ERC-20 logs in v1; inspect the fill tx manually"],
        },
      });
      continue;
    }
    const check = matchDelivery(out, transfers);
    const verdict = classify(check, { deadlineMet, finalized, expectedAmount: out.amount });
    const dec = await tokenDecimals(destChain, out.token, decimalsCache);
    results.push({ out, check, verdict, dec });
  }

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          protocol: proto.key,
          orderId: order.orderId,
          user: order.user,
          sourceChain: src.name,
          destChain: destChain.name,
          fillTx,
          fillBlock,
          fillDeadline,
          deadlineMet,
          finalized,
          outputs: results.map((r) => ({
            token: r.out.token,
            recipient: r.out.recipient,
            expected: r.out.amount.toString(),
            delivered: r.native ? null : r.check?.deliveredValue.toString(),
            status: r.verdict.status,
            anomalies: r.verdict.anomalies,
            warnings: r.verdict.warnings,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    render(proto.label, src, destChain, order, fillTx, fillBlock, fillTs, fillDeadline, results);
  }

  const bad = results.some((r) => r.verdict.status !== "settled");
  if (bad) process.exitCode = 1;

  const otherChains = [...new Set(outputs.filter((x) => x.chainId !== destChain.chainId).map((x) => x.chainId))];
  if (otherChains.length && !o.json) {
    console.log(
      `note: intent also has outputs on chainId(s) ${otherChains.join(", ")} — re-run with their --fill-tx / --dest-chain to verify those.\n`,
    );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort: scan the destination chain for the tx that fills an output —
 * ERC-20 Transfers of the expected token to the recipient, over a bounded
 * window, chunked to survive node `getLogs` range caps. Picks the earliest tx
 * that reaches the expected amount (selection logic in discovery-core).
 */
async function discoverFillTx(destChain: ChainConfig, onDest: ExpectedOutput[], scanBlocks: number): Promise<string> {
  const target = onDest.find((o) => !o.native);
  if (!target) {
    throw new Error("can't auto-discover a native-token delivery from logs — pass --fill-tx explicitly");
  }
  const provider = getProvider(destChain);
  const head = await withRetry(() => provider.getBlockNumber(), { label: "dest head" });
  const from = Math.max(0, head - Math.max(1, scanBlocks));
  const token = new Contract(target.token, ERC20_ABI, provider);
  const filter = token.filters.Transfer(null, target.recipient);

  const candidates: FillCandidate[] = [];
  let scanned = 0;
  for (const [lo, hi] of chunkRange(from, head, SCAN_CHUNK)) {
    try {
      const logs = await withRetry(() => token.queryFilter(filter, lo, hi), { label: "fill scan" });
      for (const l of logs) {
        const ev = l as unknown as { args: { value: bigint }; transactionHash: string; blockNumber: number };
        candidates.push({
          tx: ev.transactionHash,
          block: ev.blockNumber,
          token: target.token,
          to: target.recipient,
          value: ev.args.value,
        });
      }
      scanned++;
    } catch {
      // node rejected this range (cap/timeout) — skip the chunk, keep scanning
    }
  }

  const match = selectFillTx(target, candidates);
  if (!match) {
    throw new Error(
      `auto-discovery found no fill delivering ${target.amount} of ${target.token} to ${target.recipient} on ` +
        `${destChain.name} in the last ${scanBlocks} blocks (${scanned} range(s) scanned) — pass --fill-tx, widen ` +
        `--scan-blocks, or point at an archive/indexer RPC.`,
    );
  }
  return match.tx;
}

function resolveDestChain(destChainKey: string | undefined, outputs: ExpectedOutput[]): ChainConfig {
  if (destChainKey) return chain(destChainKey);
  const ids = [...new Set(outputs.map((x) => x.chainId))];
  if (ids.length === 1) {
    const c = chainById(ids[0]);
    if (!c)
      throw new Error(`destination chainId ${ids[0]} is not configured — add it to src/config.ts or pass --dest-chain`);
    return c;
  }
  throw new Error(
    `intent spans destination chainIds ${ids.join(", ")} — pass --dest-chain to pick which the fill tx is on`,
  );
}

async function tokenDecimals(c: ChainConfig, token: string, cache: Map<string, number>): Promise<number> {
  const key = `${c.key}:${token.toLowerCase()}`;
  let d = cache.get(key);
  if (d === undefined) {
    try {
      d = Number(
        await withRetry(() => new Contract(token, ERC20_ABI, getProvider(c)).decimals(), { label: "decimals" }),
      );
    } catch {
      d = 18;
    }
    cache.set(key, d);
  }
  return d;
}

// ── rendering ───────────────────────────────────────────────────────────────

interface OutResult {
  out: ExpectedOutput;
  native?: boolean;
  check?: ReturnType<typeof matchDelivery>;
  verdict: ReturnType<typeof classify>;
  dec?: number;
}

function render(
  protoLabel: string,
  src: ChainConfig,
  dest: ChainConfig,
  order: NormalizedOrder,
  fillTx: string,
  fillBlock: number,
  fillTs: number,
  fillDeadline: number,
  results: OutResult[],
): void {
  console.log(`\n${protoLabel} settlement — order ${shortAddr(order.orderId)}`);
  console.log("─".repeat(70));
  console.log(`  user        ${order.user}`);
  console.log(`  route       ${src.name} → ${dest.name}`);
  console.log(`  fill tx     ${fillTx}  (block ${fillBlock})`);
  const deadlineStr =
    fillDeadline === 0
      ? "no deadline declared"
      : `fill ${new Date(fillTs * 1000).toISOString()}  vs  ${new Date(fillDeadline * 1000).toISOString()}  ${fillTs <= fillDeadline ? "✓" : "✗ LATE"}`;
  console.log(`  deadline    ${deadlineStr}`);

  for (const r of results) {
    const mark = r.verdict.status === "settled" ? "✓" : r.verdict.status === "anomaly" ? "⚠" : "✗";
    const tokenLabel = r.native ? "native" : shortAddr(r.out.token);
    const fmt = (v: bigint): string => (r.dec !== undefined ? formatUnits(v, r.dec) : v.toString());
    console.log(
      `\n  ${mark} output → ${shortAddr(r.out.recipient)}  (${tokenLabel})  [${r.verdict.status.toUpperCase()}]`,
    );
    console.log(`     expected ${fmt(r.out.amount)}`);
    if (r.check) console.log(`     delivered ${fmt(r.check.deliveredValue)}`);
    for (const a of r.verdict.anomalies) console.log(`     ⚠ ${a}`);
    for (const w of r.verdict.warnings) console.log(`     · ${w}`);
  }
  console.log(`\n  ${txLink(dest, fillTx)}\n`);
}

// ── args ────────────────────────────────────────────────────────────────────

interface Opts {
  protocol?: string;
  sourceChain?: string;
  destChain?: string;
  intentTx?: string;
  fillTx?: string;
  scanBlocks: number;
  finalityDepth: number;
  json: boolean;
}

function parse(args: string[]): Opts {
  const o: Opts = { finalityDepth: 12, scanBlocks: 50_000, json: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--protocol":
        o.protocol = args[++i];
        break;
      case "--source-chain":
        o.sourceChain = args[++i];
        break;
      case "--dest-chain":
        o.destChain = args[++i];
        break;
      case "--intent-tx":
        o.intentTx = args[++i];
        break;
      case "--fill-tx":
        o.fillTx = args[++i];
        break;
      case "--scan-blocks":
        o.scanBlocks = Number(args[++i]);
        break;
      case "--finality-depth":
        o.finalityDepth = Number(args[++i]);
        break;
      case "--json":
        o.json = true;
        break;
    }
  }
  return o;
}
