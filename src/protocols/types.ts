import { ExpectedOutput, LogLike, ObservedTransfer } from "../settlement-core.js";

/**
 * A cross-chain intent normalized across protocols. Whatever the source format
 * (ERC-7683, Across, UniswapX, CoW), a decoder reduces it to: who the order is
 * for, what must be delivered where, and by when — so the shared
 * delivery-matching core can verify any of them the same way.
 */
export interface NormalizedOrder {
  protocol: string;
  orderId: string;
  user: string;
  /** unix seconds; 0 when the format declares no fill deadline. */
  fillDeadline: number;
  /** the outputs the filler must deliver, already address- and native-resolved. */
  outputs: ExpectedOutput[];
}

/**
 * A settlement protocol decoder. `parseIntent` reads the order-opening tx's
 * logs; `parseFill` reads the fill tx's logs into observed deliveries (default:
 * ERC-20 Transfers). Both are pure given the logs, so they unit-test offline.
 */
export interface Protocol {
  key: string;
  /** human label, e.g. "ERC-7683". */
  label: string;
  parseIntent(logs: readonly LogLike[]): NormalizedOrder | null;
  parseFill(logs: readonly LogLike[]): ObservedTransfer[];
}

export type { LogLike };
