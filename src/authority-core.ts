/**
 * Authority classification — pure logic, no network.
 *
 * evmsec already *resolves* who controls a contract (an EIP-1967 proxy admin, an
 * `owner()`, a role holder). The unanswered question — and the single most
 * recurring centralization finding in audits and 2024–2026 incidents (Bybit,
 * Drift, countless single-key rugs) — is *what kind* of authority that is:
 *
 *   - a single EOA            → one key away from a rug (worst case)
 *   - a Safe multisig         → only as strong as its threshold (1-of-N ≈ an EOA)
 *   - a TimelockController     → only as safe as its delay (0 = no exit window)
 *   - an unrecognized contract → inspect it (could be a custom controller)
 *   - the zero address         → renounced
 *
 * This folds the on-chain reads the command gathers into that verdict. It never
 * asserts safety it can't see — an unrecognized contract is "elevated, inspect",
 * not "safe".
 */

export type AuthorityKind = "renounced" | "eoa" | "safe" | "timelock" | "contract" | "unknown";

export interface SafeInfo {
  threshold: number;
  owners: number;
}
export interface TimelockInfo {
  /** the configured min delay in seconds. */
  delaySec: number;
}

export interface AuthorityVerdict {
  kind: AuthorityKind;
  risk: "critical" | "elevated" | "info";
  /** true when CI should fail: a single key (EOA or 1-of-N Safe) holds the authority. */
  fail: boolean;
  summary: string;
}

export interface AuthorityInput {
  /** the resolved authority address, or null if none was found. */
  address: string | null;
  /** true when address is the zero address (ownership renounced). */
  isZero?: boolean;
  /** true = EOA, false = contract; undefined when address is null/zero. */
  isEoa?: boolean;
  /** present when the authority is a Gnosis Safe. */
  safe?: SafeInfo | null;
  /** present when the authority is a TimelockController / Compound-style timelock. */
  timelock?: TimelockInfo | null;
  /** delay (seconds) below which a timelock is flagged as too short. Default 24h. */
  minDelaySec?: number;
}

const DEFAULT_MIN_DELAY = 24 * 60 * 60; // 24h

function fmtDuration(sec: number): string {
  if (sec <= 0) return "0";
  const h = sec / 3600;
  if (h < 48) return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Fold the resolved on-chain reads into a centralization verdict. Pure. */
export function classifyAuthority(input: AuthorityInput): AuthorityVerdict {
  const minDelay = input.minDelaySec ?? DEFAULT_MIN_DELAY;

  if (input.address === null) {
    return {
      kind: "unknown",
      risk: "info",
      fail: false,
      summary:
        "no EIP-1967 admin or owner() found — the target may gate access via AccessControl roles or a custom scheme; inspect directly.",
    };
  }

  if (input.isZero) {
    return {
      kind: "renounced",
      risk: "info",
      fail: false,
      summary:
        "authority is the zero address — renounced. No admin can act (and none can fix a bug); confirm there is no other privileged path.",
    };
  }

  if (input.safe) {
    const { threshold, owners } = input.safe;
    if (threshold <= 1) {
      return {
        kind: "safe",
        risk: "critical",
        fail: true,
        summary: `Gnosis Safe with threshold ${threshold}-of-${owners} — a 1-of-N multisig is effectively a single key.`,
      };
    }
    // A threshold below 3, or one that isn't a majority of the owners, is a thin
    // margin: a 2-key phishing/compromise (Harmony's bridge was 2-of-5) or a
    // minority of signers can move everything. Flag it for review rather than pass.
    const belowFloor = threshold < 3;
    const notMajority = threshold * 2 <= owners;
    if (belowFloor || notMajority) {
      const why = belowFloor
        ? `only ${threshold} key(s) need be compromised to gain full control`
        : `${threshold} of ${owners} is not a majority of signers`;
      return {
        kind: "safe",
        risk: "elevated",
        fail: false,
        summary: `Gnosis Safe ${threshold}-of-${owners} — low threshold (${why}). Confirm this matches the value at risk and that signers are independent.`,
      };
    }
    return {
      kind: "safe",
      risk: "info",
      fail: false,
      summary: `Gnosis Safe multisig, ${threshold}-of-${owners}. Confirm the signers are independent and the threshold matches the value at risk.`,
    };
  }

  if (input.timelock) {
    const d = input.timelock.delaySec;
    if (d <= 0) {
      return {
        kind: "timelock",
        risk: "elevated",
        fail: false,
        summary: "timelock present but the min delay is 0 — no exit window; admin actions execute immediately.",
      };
    }
    if (d < minDelay) {
      return {
        kind: "timelock",
        risk: "elevated",
        fail: false,
        summary: `timelock delay ${fmtDuration(d)} is below the ${fmtDuration(minDelay)} floor — a short exit window leaves little time to react to a malicious upgrade.`,
      };
    }
    return {
      kind: "timelock",
      risk: "info",
      fail: false,
      summary: `timelocked with a ${fmtDuration(d)} delay — actions are announced before they execute. Verify who can propose/cancel.`,
    };
  }

  if (input.isEoa) {
    return {
      kind: "eoa",
      risk: "critical",
      fail: true,
      summary: `authority is a single externally-owned account (${input.address}) — one compromised key can act unilaterally with no delay.`,
    };
  }

  // A contract, but not a recognized Safe or timelock.
  return {
    kind: "contract",
    risk: "elevated",
    fail: false,
    summary: `authority is a contract (${input.address}) that is not a recognized Gnosis Safe or timelock — inspect it (it may be a ProxyAdmin or custom controller; re-run on its owner()).`,
  };
}
