import { getAddress } from "ethers";

/** An output the filler must deliver on the destination chain (from `maxSpent`). */
export interface ExpectedOutput {
  token: string;
  amount: bigint;
  recipient: string;
  chainId: number;
  native: boolean;
}

/** An ERC-20 Transfer observed in the fill transaction. */
export interface ObservedTransfer {
  token: string;
  to: string;
  value: bigint;
}

export interface DeliveryCheck {
  /** an expected-token transfer reached the expected recipient */
  matched: boolean;
  deliveredValue: bigint;
  /** some transfer reached the recipient (maybe of a different token) */
  recipientReached: boolean;
  tokenCorrect: boolean;
  amountSufficient: boolean;
}

export interface OutputVerdict {
  status: "settled" | "unsettled" | "anomaly";
  anomalies: string[];
  warnings: string[];
}

const ZERO = "0x0000000000000000000000000000000000000000";

function eq(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

/** ERC-7683 represents native value with the zero token address. */
export function isNativeToken(token: string): boolean {
  return getAddress(token) === ZERO;
}

/**
 * Check whether the observed transfers satisfy an expected output: did the
 * intended recipient receive the intended token, and how much in total.
 */
export function matchDelivery(expected: ExpectedOutput, transfers: ObservedTransfer[]): DeliveryCheck {
  const toRecipient = transfers.filter((t) => eq(t.to, expected.recipient));
  const ofToken = toRecipient.filter((t) => eq(t.token, expected.token));
  const delivered = ofToken.reduce((sum, t) => sum + t.value, 0n);
  return {
    matched: ofToken.length > 0,
    deliveredValue: delivered,
    recipientReached: toRecipient.length > 0,
    tokenCorrect: ofToken.length > 0,
    amountSufficient: delivered >= expected.amount,
  };
}

/**
 * Turn a delivery check + timing facts into a verdict. `maxSpent` is an upper
 * bound, so an under-ceiling delivery is a warning (order-type dependent), not
 * a hard anomaly; a missing or late fill is an anomaly.
 */
export function classify(
  check: DeliveryCheck,
  opts: { deadlineMet: boolean; finalized: boolean; expectedAmount: bigint },
): OutputVerdict {
  const anomalies: string[] = [];
  const warnings: string[] = [];

  if (!check.matched) {
    anomalies.push(
      check.recipientReached
        ? "recipient received a different token than the intent specified"
        : "no delivery of the expected token reached the recipient",
    );
    return { status: "unsettled", anomalies, warnings };
  }

  if (!opts.deadlineMet) anomalies.push("fill occurred after the order's fillDeadline");
  if (!check.amountSufficient) {
    warnings.push(
      `delivered ${check.deliveredValue} is below the maxSpent ceiling ${opts.expectedAmount} — ` +
        "confirm the order type (maxSpent is an upper bound, not always the exact amount)",
    );
  }
  if (!opts.finalized) warnings.push("fill block is not yet beyond the finality depth");

  return { status: anomalies.length ? "anomaly" : "settled", anomalies, warnings };
}
