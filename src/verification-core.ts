/**
 * Source-verification status — pure classification, no network.
 *
 * A contract holding value whose source isn't verified anywhere is a yellow flag
 * in its own right: nobody can review what the bytecode actually does, and every
 * other evmsec check is working from bytecode alone. "Is this address's source
 * verified?" is a clean, on-chain-adjacent lookup, and the verdict is deterministic.
 *
 * We consult two providers so a contract verified on only one isn't falsely
 * flagged: **Sourcify** (open, metadata-hash match levels) first, then
 * **Etherscan** (the explorer most teams actually verify against) as a fallback.
 * This is the pure half: it folds the providers' answers into a verdict. The
 * command does the lookups.
 */

export type MatchLevel = "exact_match" | "match" | null;

/** What a second, boolean-style provider (Etherscan) told us — or that we skipped it. */
export type EtherscanSignal = "verified" | "unverified" | "unreachable" | undefined;

export interface VerificationInput {
  /** Sourcify v2 match level: "exact_match" (full), "match" (partial), or null (absent). */
  match: MatchLevel;
  /** true when Sourcify was reachable; false means we couldn't determine its status. */
  reachable: boolean;
  /** Optional Etherscan fallback result. Absent when not consulted (no API key). */
  etherscan?: EtherscanSignal;
}

export type VerificationStatus = "exact" | "partial" | "verified" | "unverified" | "unknown";

export interface VerificationVerdict {
  status: VerificationStatus;
  risk: "critical" | "elevated" | "info";
  /** true when CI should fail: the source is not verified on any provider we reached. */
  fail: boolean;
  /** Which provider settled the verdict, for provenance in output. */
  provider: "sourcify" | "etherscan" | "none";
  summary: string;
}

/**
 * Fold verification-provider answers into a verdict. Pure. Sourcify is
 * authoritative when it has a match (it distinguishes exact vs partial);
 * otherwise Etherscan can still rescue a contract Sourcify doesn't know. A route
 * only fails when a reachable provider says "not verified" and none says it is.
 */
export function classifyVerification(input: VerificationInput): VerificationVerdict {
  // Sourcify positive match wins outright — it's the most precise signal.
  if (input.match === "exact_match") {
    return {
      status: "exact",
      risk: "info",
      fail: false,
      provider: "sourcify",
      summary:
        "source is verified with a full (exact) match — the deployed bytecode and metadata match the published source exactly.",
    };
  }
  if (input.match === "match") {
    return {
      status: "partial",
      risk: "info",
      fail: false,
      provider: "sourcify",
      summary:
        "source is verified with a partial match — the bytecode matches but the metadata hash differs (e.g. different compile path or comments). Functionally verified; confirm the source is the one you expect.",
    };
  }

  // Sourcify has no match. Etherscan can still confirm the source is published.
  if (input.etherscan === "verified") {
    return {
      status: "verified",
      risk: "info",
      fail: false,
      provider: "etherscan",
      summary:
        "source is verified on Etherscan (Sourcify has no match). The published source can be reviewed; confirm it's the one you expect.",
    };
  }

  // Nobody says verified. Fail if any provider we reached says "not verified".
  const sourcifySaysNo = input.reachable; // reachable + no match ⇒ Sourcify has none
  const etherscanSaysNo = input.etherscan === "unverified";
  if (sourcifySaysNo || etherscanSaysNo) {
    return {
      status: "unverified",
      risk: "elevated",
      fail: true,
      provider: "none",
      summary:
        "no verified source found on Sourcify or Etherscan — the contract's source is not published, so it can only be reviewed as raw bytecode. Treat an unverified contract holding value with suspicion.",
    };
  }

  // Nothing reachable — not a verdict, just an inconclusive lookup.
  return {
    status: "unknown",
    risk: "info",
    fail: false,
    provider: "none",
    summary:
      "couldn't reach a verification provider — status unknown (network/provider issue, not a verdict). Retry or check the explorer directly.",
  };
}
