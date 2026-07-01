/**
 * Oracle-hygiene classification — pure logic, no network.
 *
 * A stale or broken price feed is one of the top recurring DeFi loss causes:
 * a protocol that reads `latestRoundData()` and trusts it blindly will price
 * collateral off a number that stopped updating hours ago (or went to zero),
 * and on an L2 it will trust prices that were frozen while the sequencer was
 * down. Every one of those failure modes is an *on-chain-readable invariant* —
 * exactly evmsec's lane.
 *
 * This folds a Chainlink-style `latestRoundData()` read (and, on L2s, the
 * sequencer-uptime feed) into a verdict. It never asserts a price is *correct*
 * — it can't see that — only that the feed is fresh, positive, and (on L2)
 * served while the sequencer was reliably up.
 */

export interface RoundData {
  /** the reported answer (price), raw integer at the feed's `decimals`. */
  answer: bigint;
  /** unix seconds when this round was last updated. 0 means the round is incomplete. */
  updatedAt: number;
  /** the round this answer belongs to (older aggregators). */
  roundId?: bigint;
  /** the round in which the answer was actually computed; < roundId means a carried-over stale answer. */
  answeredInRound?: bigint;
}

/**
 * The L2 sequencer-uptime feed (Chainlink): `answer` is 0 when the sequencer is
 * up, 1 when down; `startedAt` is when the current status began. After the
 * sequencer comes back up, prices are not yet trustworthy until a grace period
 * has elapsed.
 */
export interface SequencerStatus {
  /** false when the uptime feed reports the sequencer as down (answer == 1). */
  up: boolean;
  /** unix seconds the current up/down status began (the feed's `startedAt`). */
  since: number;
}

export interface OracleInput {
  round: RoundData;
  /** current time, unix seconds (passed in so the classifier stays pure). */
  now: number;
  /** the feed's heartbeat — the max age (seconds) a fresh answer should ever reach. */
  heartbeatSec: number;
  /** decimals, for display only. */
  decimals?: number;
  /** present only on L2s where a sequencer-uptime feed was supplied. */
  sequencer?: SequencerStatus;
  /** grace period after a sequencer restart before prices are trusted. Default 1h. */
  sequencerGraceSec?: number;
}

export type OracleRisk = "critical" | "elevated" | "info";

export interface OracleVerdict {
  risk: OracleRisk;
  /** true when CI should fail: the feed is unusable (no data, non-positive, or stale past heartbeat). */
  fail: boolean;
  /** age of the latest answer in seconds (now - updatedAt). */
  ageSec: number;
  /** the answer is older than the heartbeat. */
  stale: boolean;
  /** the answer was carried over from an earlier round (answeredInRound < roundId). */
  staleRound: boolean;
  /** the answer is zero or negative — never a valid price. */
  nonPositive: boolean;
  summary: string;
}

export const DEFAULT_SEQUENCER_GRACE = 60 * 60; // 1h, per Chainlink's L2 guidance

function fmtAge(sec: number): string {
  if (sec < 0) return "0s";
  if (sec < 90) return `${sec}s`;
  const m = sec / 60;
  if (m < 90) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = sec / 3600;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/**
 * Fold the latest round (and optional sequencer status) into a hygiene verdict.
 * Pure. Precedence: sequencer-down → no-data → non-positive → stale → stale-round
 * → (sequencer in grace) → healthy.
 */
export function classifyOracle(input: OracleInput): OracleVerdict {
  const { round, now, heartbeatSec } = input;
  const ageSec = Math.max(0, now - round.updatedAt);
  const stale = round.updatedAt > 0 && ageSec > heartbeatSec;
  const nonPositive = round.answer <= 0n;
  const staleRound =
    round.roundId !== undefined && round.answeredInRound !== undefined && round.answeredInRound < round.roundId;

  const base = { ageSec, stale, staleRound, nonPositive };

  // L2 sequencer takes precedence — a fresh-looking price means nothing if the
  // chain it priced was offline.
  if (input.sequencer) {
    const grace = input.sequencerGraceSec ?? DEFAULT_SEQUENCER_GRACE;
    if (!input.sequencer.up) {
      return {
        ...base,
        risk: "critical",
        fail: true,
        summary: "L2 sequencer is DOWN per the uptime feed — prices are frozen and must not be trusted.",
      };
    }
    const upFor = Math.max(0, now - input.sequencer.since);
    if (upFor < grace) {
      return {
        ...base,
        risk: "elevated",
        fail: false,
        summary: `L2 sequencer came back up ${fmtAge(upFor)} ago — within the ${fmtAge(
          grace,
        )} grace window; prices may not be reliable yet.`,
      };
    }
  }

  if (round.updatedAt <= 0) {
    return {
      ...base,
      risk: "critical",
      fail: true,
      summary: "latestRoundData() returned updatedAt == 0 — the round is incomplete / there is no answer to trust.",
    };
  }

  if (nonPositive) {
    return {
      ...base,
      risk: "critical",
      fail: true,
      summary: `feed answer is ${round.answer.toString()} (≤ 0) — never a valid price; a consumer dividing by or pricing off this is exploitable.`,
    };
  }

  if (stale) {
    return {
      ...base,
      risk: "critical",
      fail: true,
      summary: `latest answer is ${fmtAge(ageSec)} old — past the ${fmtAge(
        heartbeatSec,
      )} heartbeat; the feed has stopped updating and consumers are pricing off stale data.`,
    };
  }

  if (staleRound) {
    return {
      ...base,
      risk: "elevated",
      fail: false,
      summary: `answeredInRound (${round.answeredInRound}) < roundId (${round.roundId}) — the answer was carried over from an earlier round; treat as potentially stale.`,
    };
  }

  return {
    ...base,
    risk: "info",
    fail: false,
    summary: `feed is fresh — last updated ${fmtAge(ageSec)} ago, within the ${fmtAge(
      heartbeatSec,
    )} heartbeat, with a positive answer. (Freshness only; this can't attest the price is correct or sourced from enough nodes.)`,
  };
}
