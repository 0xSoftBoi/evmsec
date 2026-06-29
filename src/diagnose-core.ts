/**
 * Settlement diagnosis — pure logic, no network.
 *
 * The forensic counterpart to verification: an intent that *should* have settled
 * but didn't. Given the deliveries of the expected token that reached the
 * intended recipient (and whether any deadline applied), classify the failure
 * mode with on-chain evidence. The scan that gathers the deliveries lives in the
 * command; this is the testable decision step.
 */

export type FailureMode = "settled" | "filled-late" | "underfilled" | "never-filled";

/** One observed delivery of the expected token to the recipient. */
export interface Delivery {
  value: bigint;
  ts: number; // block timestamp (unix seconds)
  tx: string;
}

export interface Diagnosis {
  mode: FailureMode;
  /** the tx that completed (or last contributed to) the delivery, when any. */
  tx?: string;
  deliveredValue: bigint;
  evidence: string[];
}

/**
 * Classify the settlement outcome from the deliveries that reached the recipient.
 *
 *   - none at all        → never-filled (could also be a wrong-recipient fill —
 *                          inspect; distinguishing needs a full token-transfer scan)
 *   - some but < amount  → underfilled
 *   - >= amount, on time → settled
 *   - >= amount, late    → filled-late
 */
export function diagnose(args: {
  amount: bigint;
  /** fill deadline in unix seconds; 0 means none declared. */
  deadline: number;
  toRecipient: readonly Delivery[];
}): Diagnosis {
  const ordered = [...args.toRecipient].sort((a, b) => a.ts - b.ts);
  const total = ordered.reduce((s, d) => s + d.value, 0n);

  if (ordered.length === 0) {
    return {
      mode: "never-filled",
      deliveredValue: 0n,
      evidence: [
        "no delivery of the expected token reached the recipient in the scanned window",
        "if you expected a fill, check for a wrong-recipient delivery or widen the scan",
      ],
    };
  }

  if (total < args.amount) {
    return {
      mode: "underfilled",
      tx: ordered[ordered.length - 1].tx,
      deliveredValue: total,
      evidence: [
        `delivered ${total} of the expected ${args.amount} to the recipient (short by ${args.amount - total})`,
      ],
    };
  }

  // Find the delivery that first pushed the cumulative total to >= amount.
  let cum = 0n;
  let completing = ordered[ordered.length - 1];
  for (const d of ordered) {
    cum += d.value;
    if (cum >= args.amount) {
      completing = d;
      break;
    }
  }

  const onTime = args.deadline === 0 || completing.ts <= args.deadline;
  if (onTime) {
    return {
      mode: "settled",
      tx: completing.tx,
      deliveredValue: total,
      evidence: [`delivery reached ${args.amount} at ${iso(completing.ts)} in ${completing.tx}`],
    };
  }
  return {
    mode: "filled-late",
    tx: completing.tx,
    deliveredValue: total,
    evidence: [
      `delivery completed at ${iso(completing.ts)}, after the fill deadline ${iso(args.deadline)}`,
      `late by ${completing.ts - args.deadline} seconds`,
    ],
  };
}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString();
}
