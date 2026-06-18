import { Contract, formatUnits } from "ethers";
import { ChainConfig, chain, chainById } from "../config.js";
import {
  ERC20_ABI,
  bytes32ToAddress,
  erc20Interface,
  erc7683Interface,
  getBlockCached,
  getProvider,
  shortAddr,
  txLink,
} from "../lib.js";
import { ExpectedOutput, ObservedTransfer, classify, isNativeToken, matchDelivery } from "../settlement-core.js";

/**
 * `evmsec settlement --source-chain <c> --intent-tx <openTx> --fill-tx <fillTx>`
 *
 * Verifies an ERC-7683 cross-chain intent was actually fulfilled: decodes the
 * `Open` event on the source chain to learn what the filler promised to deliver
 * (`maxSpent`), then checks the destination `fill` tx really delivered that
 * token/amount to the intended recipient, before the fillDeadline, and final.
 */
export async function settlement(args: string[]): Promise<void> {
  const o = parse(args);
  if (!o.sourceChain || !o.intentTx || !o.fillTx) {
    throw new Error(
      "usage: evmsec settlement --source-chain <c> --intent-tx <openTx> --fill-tx <fillTx> " +
        "[--dest-chain <c>] [--finality-depth 12] [--json]\n" +
        "(v1 verifies ERC-7683 orders; auto-discovery of the fill tx is on the roadmap)",
    );
  }

  const src = chain(o.sourceChain);
  const order = await decodeOpen(src, o.intentTx);

  const outputs: ExpectedOutput[] = order.maxSpent.map((x) => {
    const token = bytes32ToAddress(x.token);
    return { token, amount: x.amount, recipient: bytes32ToAddress(x.recipient), chainId: Number(x.chainId), native: isNativeToken(token) };
  });
  if (outputs.length === 0) throw new Error("intent has no maxSpent outputs to verify");

  const destChain = resolveDestChain(o.destChain, outputs);
  const destProvider = getProvider(destChain);

  const fillReceipt = await destProvider.getTransactionReceipt(o.fillTx);
  if (!fillReceipt) throw new Error(`fill tx not found on ${destChain.name}: ${o.fillTx}`);
  const transfers = decodeTransfers(fillReceipt.logs);
  const fillBlock = fillReceipt.blockNumber;
  const [fillTs, destHead] = await Promise.all([
    getBlockCached(destProvider, destChain.key, fillBlock).then((b) => b.timestamp),
    destProvider.getBlockNumber(),
  ]);
  const finalized = destHead - fillBlock >= o.finalityDepth;
  const fillDeadline = Number(order.fillDeadline);
  const deadlineMet = fillTs <= fillDeadline;

  const onDest = outputs.filter((x) => x.chainId === destChain.chainId);
  const decimalsCache = new Map<string, number>();

  const results = [];
  for (const out of onDest) {
    if (out.native) {
      results.push({ out, native: true, verdict: { status: "anomaly" as const, anomalies: [], warnings: ["native-token output — not verifiable from ERC-20 logs in v1; inspect the fill tx manually"] } });
      continue;
    }
    const check = matchDelivery(out, transfers);
    const verdict = classify(check, { deadlineMet, finalized, expectedAmount: out.amount });
    const dec = await tokenDecimals(destChain, out.token, decimalsCache);
    results.push({ out, check, verdict, dec });
  }

  if (o.json) {
    console.log(JSON.stringify({
      orderId: order.orderId,
      user: order.user,
      sourceChain: src.name,
      destChain: destChain.name,
      fillTx: o.fillTx,
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
    }, null, 2));
  } else {
    render(src, destChain, order, o.fillTx, fillBlock, fillTs, fillDeadline, results);
  }

  const bad = results.some((r) => r.verdict.status !== "settled");
  if (bad) process.exitCode = 1;

  const otherChains = [...new Set(outputs.filter((x) => x.chainId !== destChain.chainId).map((x) => x.chainId))];
  if (otherChains.length && !o.json) {
    console.log(`note: intent also has outputs on chainId(s) ${otherChains.join(", ")} — re-run with their --fill-tx / --dest-chain to verify those.\n`);
  }
}

// ── decoding ────────────────────────────────────────────────────────────────

interface RawOutput { token: string; amount: bigint; recipient: string; chainId: bigint; }
interface OpenOrder { orderId: string; user: string; fillDeadline: bigint; maxSpent: RawOutput[]; }

async function decodeOpen(src: ChainConfig, intentTx: string): Promise<OpenOrder> {
  const receipt = await getProvider(src).getTransactionReceipt(intentTx);
  if (!receipt) throw new Error(`intent tx not found on ${src.name}: ${intentTx}`);

  const openTopic = erc7683Interface.getEvent("Open")!.topicHash;
  for (const log of receipt.logs) {
    if (log.topics[0] !== openTopic) continue;
    const parsed = erc7683Interface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) continue;
    const ro = parsed.args.resolvedOrder;
    const maxSpent: RawOutput[] = ro.maxSpent.map((x: { token: string; amount: bigint; recipient: string; chainId: bigint }) => ({
      token: x.token, amount: x.amount, recipient: x.recipient, chainId: x.chainId,
    }));
    return { orderId: parsed.args.orderId as string, user: ro.user as string, fillDeadline: ro.fillDeadline as bigint, maxSpent };
  }
  throw new Error(`no ERC-7683 Open event in ${intentTx} on ${src.name} — is this the order-opening tx?`);
}

function decodeTransfers(logs: readonly { address: string; topics: readonly string[]; data: string }[]): ObservedTransfer[] {
  const out: ObservedTransfer[] = [];
  for (const log of logs) {
    try {
      const p = erc20Interface.parseLog({ topics: [...log.topics], data: log.data });
      if (p?.name === "Transfer") out.push({ token: log.address, to: p.args.to as string, value: p.args.value as bigint });
    } catch {
      // not an ERC-20 Transfer — skip
    }
  }
  return out;
}

function resolveDestChain(destChainKey: string | undefined, outputs: ExpectedOutput[]): ChainConfig {
  if (destChainKey) return chain(destChainKey);
  const ids = [...new Set(outputs.map((x) => x.chainId))];
  if (ids.length === 1) {
    const c = chainById(ids[0]);
    if (!c) throw new Error(`destination chainId ${ids[0]} is not configured — add it to src/config.ts or pass --dest-chain`);
    return c;
  }
  throw new Error(`intent spans destination chainIds ${ids.join(", ")} — pass --dest-chain to pick which the fill tx is on`);
}

async function tokenDecimals(c: ChainConfig, token: string, cache: Map<string, number>): Promise<number> {
  const key = `${c.key}:${token.toLowerCase()}`;
  let d = cache.get(key);
  if (d === undefined) {
    try {
      d = Number(await new Contract(token, ERC20_ABI, getProvider(c)).decimals());
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
  src: ChainConfig,
  dest: ChainConfig,
  order: OpenOrder,
  fillTx: string,
  fillBlock: number,
  fillTs: number,
  fillDeadline: number,
  results: OutResult[],
): void {
  console.log(`\nERC-7683 settlement — order ${shortAddr(order.orderId)}`);
  console.log("─".repeat(70));
  console.log(`  user        ${order.user}`);
  console.log(`  route       ${src.name} → ${dest.name}`);
  console.log(`  fill tx     ${fillTx}  (block ${fillBlock})`);
  console.log(`  deadline    fill ${new Date(fillTs * 1000).toISOString()}  vs  ${new Date(fillDeadline * 1000).toISOString()}  ${fillTs <= fillDeadline ? "✓" : "✗ LATE"}`);

  for (const r of results) {
    const mark = r.verdict.status === "settled" ? "✓" : r.verdict.status === "anomaly" ? "⚠" : "✗";
    const tokenLabel = r.native ? "native" : shortAddr(r.out.token);
    const fmt = (v: bigint) => (r.dec !== undefined ? formatUnits(v, r.dec) : v.toString());
    console.log(`\n  ${mark} output → ${shortAddr(r.out.recipient)}  (${tokenLabel})  [${r.verdict.status.toUpperCase()}]`);
    console.log(`     expected ${fmt(r.out.amount)}`);
    if (r.check) console.log(`     delivered ${fmt(r.check.deliveredValue)}`);
    for (const a of r.verdict.anomalies) console.log(`     ⚠ ${a}`);
    for (const w of r.verdict.warnings) console.log(`     · ${w}`);
  }
  console.log(`\n  ${txLink(dest, fillTx)}\n`);
}

// ── args ────────────────────────────────────────────────────────────────────

interface Opts {
  sourceChain?: string;
  destChain?: string;
  intentTx?: string;
  fillTx?: string;
  finalityDepth: number;
  json: boolean;
}

function parse(args: string[]): Opts {
  const o: Opts = { finalityDepth: 12, json: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--source-chain": o.sourceChain = args[++i]; break;
      case "--dest-chain": o.destChain = args[++i]; break;
      case "--intent-tx": o.intentTx = args[++i]; break;
      case "--fill-tx": o.fillTx = args[++i]; break;
      case "--finality-depth": o.finalityDepth = Number(args[++i]); break;
      case "--json": o.json = true; break;
    }
  }
  return o;
}
