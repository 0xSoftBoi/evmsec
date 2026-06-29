import { getAddress } from "ethers";

/**
 * Fill auto-discovery — pure logic, no network.
 *
 * Given what an intent promised (an expected output) and the candidate ERC-20
 * transfers observed on the destination chain, pick the transaction that fills
 * it: the earliest tx whose transfers of the expected token to the expected
 * recipient sum to at least the expected amount. The network scan that produces
 * the candidates lives in the command; this is the testable selection step.
 */

export interface FillCandidate {
  tx: string;
  block: number;
  token: string;
  to: string;
  value: bigint;
}

export interface FillMatch {
  tx: string;
  block: number;
  deliveredValue: bigint;
}

function eq(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/**
 * Select the fill tx for an expected output from candidate transfers. Returns
 * the earliest (lowest-block, then first-seen) transaction whose matching
 * transfers reach the expected amount, or null if none does.
 */
export function selectFillTx(
  expected: { token: string; recipient: string; amount: bigint },
  candidates: readonly FillCandidate[],
): FillMatch | null {
  // Keep only transfers of the right token to the right recipient.
  const relevant = candidates.filter((c) => eq(c.token, expected.token) && eq(c.to, expected.recipient));
  if (relevant.length === 0) return null;

  // Sum per tx, tracking the lowest block and first-seen order for tie-breaks.
  const byTx = new Map<string, { block: number; sum: bigint; order: number }>();
  relevant.forEach((c, i) => {
    const cur = byTx.get(c.tx);
    if (cur) {
      cur.sum += c.value;
      cur.block = Math.min(cur.block, c.block);
    } else {
      byTx.set(c.tx, { block: c.block, sum: c.value, order: i });
    }
  });

  const satisfying = [...byTx.entries()]
    .filter(([, v]) => v.sum >= expected.amount)
    .sort((a, b) => a[1].block - b[1].block || a[1].order - b[1].order);

  if (satisfying.length === 0) return null;
  const [tx, v] = satisfying[0];
  return { tx, block: v.block, deliveredValue: v.sum };
}

/** Split [from, to] into ascending sub-ranges of at most `size` blocks (for getLogs caps). */
export function chunkRange(from: number, to: number, size: number): Array<[number, number]> {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.max(from, to);
  const step = Math.max(1, size);
  const chunks: Array<[number, number]> = [];
  for (let start = lo; start <= hi; start += step) {
    chunks.push([start, Math.min(start + step - 1, hi)]);
  }
  return chunks;
}
