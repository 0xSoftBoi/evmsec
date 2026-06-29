/**
 * Source-verification status — pure classification, no network.
 *
 * A contract holding value whose source isn't verified anywhere is a yellow flag
 * in its own right: nobody can review what the bytecode actually does, and every
 * other evmsec check is working from bytecode alone. "Is this address's source
 * verified?" is a clean, on-chain-adjacent lookup (Sourcify / a block explorer),
 * and the verdict is deterministic.
 *
 * This is the pure half: it folds a verification provider's answer into a
 * verdict. The command does the lookup.
 */

export type MatchLevel = "exact_match" | "match" | null;

export interface VerificationInput {
  /** Sourcify v2 match level: "exact_match" (full), "match" (partial), or null (absent). */
  match: MatchLevel;
  /** true when the provider was reachable; false means we couldn't determine status. */
  reachable: boolean;
}

export type VerificationStatus = "exact" | "partial" | "unverified" | "unknown";

export interface VerificationVerdict {
  status: VerificationStatus;
  risk: "critical" | "elevated" | "info";
  /** true when CI should fail: the source is not verified anywhere we checked. */
  fail: boolean;
  summary: string;
}

/** Fold a verification-provider answer into a verdict. Pure. */
export function classifyVerification(input: VerificationInput): VerificationVerdict {
  if (!input.reachable) {
    return {
      status: "unknown",
      risk: "info",
      fail: false,
      summary:
        "couldn't reach the verification provider — status unknown (network/provider issue, not a verdict). Retry or check the explorer directly.",
    };
  }

  if (input.match === "exact_match") {
    return {
      status: "exact",
      risk: "info",
      fail: false,
      summary:
        "source is verified with a full (exact) match — the deployed bytecode and metadata match the published source exactly.",
    };
  }

  if (input.match === "match") {
    return {
      status: "partial",
      risk: "info",
      fail: false,
      summary:
        "source is verified with a partial match — the bytecode matches but the metadata hash differs (e.g. different compile path or comments). Functionally verified; confirm the source is the one you expect.",
    };
  }

  return {
    status: "unverified",
    risk: "elevated",
    fail: true,
    summary:
      "no verified source found — the contract's source is not published, so it can only be reviewed as raw bytecode. Treat an unverified contract holding value with suspicion.",
  };
}
