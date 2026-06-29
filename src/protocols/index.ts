import { Protocol } from "./types.js";
import { erc7683 } from "./erc7683.js";

/** All settlement protocols this tool can decode, keyed by `--protocol` value. */
export const PROTOCOLS: Record<string, Protocol> = {
  [erc7683.key]: erc7683,
};

export const DEFAULT_PROTOCOL = erc7683.key;

export function getProtocol(key: string): Protocol {
  const p = PROTOCOLS[key];
  if (!p) {
    throw new Error(`unknown protocol "${key}". Known: ${Object.keys(PROTOCOLS).join(", ")}`);
  }
  return p;
}

export type { Protocol, NormalizedOrder, LogLike } from "./types.js";
