import { Contract } from "ethers";
import { ChainConfig, chain } from "../config.js";
import { addrLink, getProvider, requireAddress, withRetry } from "../lib.js";
import { OracleVerdict, RoundData, SequencerStatus, classifyOracle } from "../oracle-core.js";

/**
 * `evmsec oracle-hygiene <feed> [--chain] [--heartbeat <sec>] [--sequencer <addr>] [--grace <sec>] [--json]`
 *
 * Is a Chainlink-style price feed actually safe to read right now? Pulls
 * `latestRoundData()` and flags the failure modes a consumer can't see when it
 * blindly trusts the returned price: a **stale** answer (older than the feed's
 * heartbeat), a **zero/negative** answer, a **carried-over** round, and — on an
 * L2 — a price served while the **sequencer was down** (or only just restarted).
 *
 * Exit code is non-zero when the feed is unusable, so it drops into CI.
 */
const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];

export async function oracleHygiene(args: string[]): Promise<void> {
  const { address, chainKey, heartbeatSec, sequencerAddr, graceSec, json } = parse(args);
  if (!address)
    throw new Error(
      "usage: evmsec oracle-hygiene <feed> [--chain ethereum] [--heartbeat <sec>] [--sequencer <addr>] [--grace <sec>] [--json]",
    );

  const c = chain(chainKey);
  const provider = getProvider(c);
  const feedAddr = requireAddress(address);
  const feed = new Contract(feedAddr, AGGREGATOR_ABI, provider);

  const [latest, decimals, description, block] = await Promise.all([
    withRetry(() => feed.latestRoundData(), { label: "latestRoundData" }),
    withRetry(() => feed.decimals(), { label: "decimals" }).catch(() => undefined),
    withRetry(() => feed.description(), { label: "description" }).catch(() => undefined),
    withRetry(() => provider.getBlock("latest"), { label: "latest block" }),
  ]);

  const round: RoundData = {
    answer: BigInt(latest.answer),
    updatedAt: Number(latest.updatedAt),
    roundId: BigInt(latest.roundId),
    answeredInRound: BigInt(latest.answeredInRound),
  };
  const now = Number(block?.timestamp ?? 0);

  let sequencer: SequencerStatus | undefined;
  if (sequencerAddr) {
    const seqFeed = new Contract(requireAddress(sequencerAddr), AGGREGATOR_ABI, provider);
    const seq = await withRetry(() => seqFeed.latestRoundData(), { label: "sequencer latestRoundData" });
    // Chainlink uptime feed: answer 0 = up, 1 = down; startedAt = when the status began.
    sequencer = { up: BigInt(seq.answer) === 0n, since: Number(seq.startedAt) };
  }

  const verdict = classifyOracle({
    round,
    now,
    heartbeatSec,
    decimals: decimals === undefined ? undefined : Number(decimals),
    sequencer,
    sequencerGraceSec: graceSec,
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          address: feedAddr,
          chain: c.key,
          description: description ?? null,
          decimals: decimals === undefined ? null : Number(decimals),
          answer: round.answer.toString(),
          updatedAt: round.updatedAt,
          ageSec: verdict.ageSec,
          heartbeatSec,
          sequencer: sequencer ?? null,
          stale: verdict.stale,
          staleRound: verdict.staleRound,
          nonPositive: verdict.nonPositive,
          risk: verdict.risk,
          summary: verdict.summary,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, feedAddr, description, decimals === undefined ? undefined : Number(decimals), round, sequencer, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
}

const RISK_MARK: Record<string, string> = { critical: "✗ CRITICAL", elevated: "⚠ ELEVATED", info: "· INFO" };

function fmtAnswer(answer: bigint, decimals?: number): string {
  if (decimals === undefined) return answer.toString();
  const neg = answer < 0n;
  const abs = neg ? -answer : answer;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? "." + s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac === "." ? "" : frac}`;
}

function print(
  c: ChainConfig,
  feed: string,
  description: string | undefined,
  decimals: number | undefined,
  round: RoundData,
  sequencer: SequencerStatus | undefined,
  v: OracleVerdict,
): void {
  console.log(`\nOracle-hygiene — ${description ? `${description} ` : ""}${feed} on ${c.name}`);
  console.log("─".repeat(68));
  console.log(`  feed            ${feed}\n                  ${addrLink(c, feed)}`);
  console.log(`  answer          ${fmtAnswer(round.answer, decimals)}${decimals !== undefined ? "" : " (raw)"}`);
  console.log(`  age             ${v.ageSec}s since last update`);
  if (sequencer) console.log(`  L2 sequencer    ${sequencer.up ? "up" : "DOWN"}`);
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  console.log(`\n  ${v.summary}`);
  console.log(`\n  Freshness/liveness only — this can't attest the price is correct.\n`);
}

function parse(args: string[]): {
  address?: string;
  chainKey: string;
  heartbeatSec: number;
  sequencerAddr?: string;
  graceSec?: number;
  json: boolean;
} {
  let address: string | undefined;
  let chainKey = "ethereum";
  let heartbeatSec = 3600;
  let sequencerAddr: string | undefined;
  let graceSec: number | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--chain requires a value (e.g. --chain base)");
      chainKey = args[++i];
    } else if (args[i] === "--heartbeat") {
      const sec = Number(args[++i]);
      if (!Number.isFinite(sec) || sec <= 0) throw new Error("--heartbeat requires a positive number of seconds");
      heartbeatSec = Math.round(sec);
    } else if (args[i] === "--sequencer") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--sequencer requires an address");
      sequencerAddr = args[++i];
    } else if (args[i] === "--grace") {
      const sec = Number(args[++i]);
      if (!Number.isFinite(sec) || sec < 0) throw new Error("--grace requires a non-negative number of seconds");
      graceSec = Math.round(sec);
    } else if (args[i] === "--json") json = true;
    else if (!address) address = args[i];
  }
  return { address, chainKey, heartbeatSec, sequencerAddr, graceSec, json };
}
