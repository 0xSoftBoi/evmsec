/**
 * Cross-chain message-proof classification — pure logic, no network.
 *
 * Settlement (and a lock-and-mint bridge) confirms a *token delivery*. The
 * stronger guarantee is that a *validly attested message* actually crossed the
 * messaging layer. This module holds the pure pieces: parsing a Wormhole VAA
 * header for display, and folding a layer's on-chain read into a verdict. The
 * `verified` state is set true ONLY when the underlying attestation is confirmed
 * on the destination — never inferred.
 */

export type ProofStatus = "verified" | "unverified" | "indeterminate";

export interface MessageProofVerdict {
  layer: string;
  status: ProofStatus;
  detail: string[];
}

/** Parsed header of a Wormhole VAA (signatures skipped; body fields decoded). */
export interface VaaHeader {
  version: number;
  guardianSetIndex: number;
  numSignatures: number;
  timestamp: number;
  nonce: number;
  emitterChain: number;
  emitterAddress: string; // 0x + 64 hex
  sequence: bigint;
  consistencyLevel: number;
}

function bytesOf(hex: string): Uint8Array {
  const h = hex.toLowerCase().replace(/^0x/, "");
  if (h.length % 2 !== 0) throw new Error("VAA hex has an odd length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("VAA contains non-hex characters");
    out[i] = byte;
  }
  return out;
}

const u = (b: Uint8Array, o: number, n: number): number => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return v;
};
const u64 = (b: Uint8Array, o: number): bigint => {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = v * 256n + BigInt(b[o + i]);
  return v;
};
const hex = (b: Uint8Array, o: number, n: number): string =>
  "0x" + Array.from(b.slice(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Parse the structural header of a Wormhole VAA. Layout: version(1),
 * guardianSetIndex(4), numSignatures(1), signatures(66 each), then the body —
 * timestamp(4), nonce(4), emitterChain(2), emitterAddress(32), sequence(8),
 * consistencyLevel(1), payload. Throws on a malformed/too-short VAA.
 */
export function parseVaaHeader(vaa: string): VaaHeader {
  const b = bytesOf(vaa);
  if (b.length < 6) throw new Error("VAA too short for a header");
  const version = b[0];
  const guardianSetIndex = u(b, 1, 4);
  const numSignatures = b[5];
  const body = 6 + numSignatures * 66;
  if (b.length < body + 51) throw new Error("VAA too short for its body");
  return {
    version,
    guardianSetIndex,
    numSignatures,
    timestamp: u(b, body, 4),
    nonce: u(b, body + 4, 4),
    emitterChain: u(b, body + 8, 2),
    emitterAddress: hex(b, body + 10, 32),
    sequence: u64(b, body + 42),
    consistencyLevel: b[body + 50],
  };
}

/**
 * Wormhole: `valid` is the result of `Core.parseAndVerifyVM` — the guardian
 * signatures are cryptographically valid for the current guardian set. That, and
 * only that, makes the message verified.
 */
export function classifyWormhole(valid: boolean, reason: string, header?: VaaHeader): MessageProofVerdict {
  const detail: string[] = [];
  if (header) {
    detail.push(
      `VAA v${header.version}, guardian set ${header.guardianSetIndex}, ${header.numSignatures} signature(s)`,
      `emitter chain ${header.emitterChain}, sequence ${header.sequence}`,
    );
  }
  if (valid) {
    detail.push("guardian signatures are valid for the current guardian set (attestation confirmed)");
    return { layer: "wormhole", status: "verified", detail };
  }
  detail.push(`Core.parseAndVerifyVM rejected the VAA: ${reason || "invalid"}`);
  return { layer: "wormhole", status: "unverified", detail };
}

/**
 * Hyperlane: `Mailbox.delivered(messageId)` is true only after `process()` ran
 * the message through its ISM and executed it — i.e. the message was validly
 * verified and delivered on the destination.
 */
export function classifyHyperlane(delivered: boolean): MessageProofVerdict {
  if (delivered) {
    return {
      layer: "hyperlane",
      status: "verified",
      detail: ["Mailbox.delivered = true — the message passed its ISM and was executed on the destination"],
    };
  }
  return {
    layer: "hyperlane",
    status: "unverified",
    detail: ["Mailbox.delivered = false — not yet relayed/verified on the destination (or the id is wrong)"],
  };
}
