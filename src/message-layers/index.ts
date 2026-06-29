import { MessageLayer } from "./types.js";
import { hyperlane } from "./hyperlane.js";
import { wormhole } from "./wormhole.js";

/**
 * Messaging layers whose attestation is confirmable by an eth_call on the
 * destination. LayerZero is intentionally absent: verifying a specific message's
 * DVN attestation needs the full Origin/nonce context and the receiver's
 * configured DVN set, not a single view call — a separate lift (see ROADMAP).
 */
export const LAYERS: Record<string, MessageLayer> = {
  [hyperlane.key]: hyperlane,
  [wormhole.key]: wormhole,
};

export function getLayer(key: string): MessageLayer {
  const l = LAYERS[key];
  if (!l) throw new Error(`unknown messaging layer "${key}". Known: ${Object.keys(LAYERS).join(", ")}`);
  return l;
}

export type { MessageLayer, VerifyArgs } from "./types.js";
