import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVaaHeader, classifyWormhole, classifyHyperlane } from "./message-proof-core.js";

// Build a minimal but structurally-valid VAA hex for the header parser.
function buildVaa(opts: { gsi: number; numSigs: number; emitterChain: number; sequence: bigint }): string {
  const parts: string[] = [];
  parts.push("01"); // version
  parts.push(opts.gsi.toString(16).padStart(8, "0")); // guardianSetIndex u32
  parts.push(opts.numSigs.toString(16).padStart(2, "0")); // numSignatures u8
  for (let i = 0; i < opts.numSigs; i++) parts.push("00".repeat(66)); // signatures (66 bytes each)
  // body:
  parts.push("00000001"); // timestamp
  parts.push("00000002"); // nonce
  parts.push(opts.emitterChain.toString(16).padStart(4, "0")); // emitterChain u16
  parts.push("aa".repeat(32)); // emitterAddress bytes32
  parts.push(opts.sequence.toString(16).padStart(16, "0")); // sequence u64
  parts.push("0f"); // consistencyLevel
  parts.push("dead"); // payload
  return "0x" + parts.join("");
}

test("parseVaaHeader: decodes version, guardian set, emitter, sequence", () => {
  const vaa = buildVaa({ gsi: 7, numSigs: 13, emitterChain: 2, sequence: 123456789n });
  const h = parseVaaHeader(vaa);
  assert.equal(h.version, 1);
  assert.equal(h.guardianSetIndex, 7);
  assert.equal(h.numSignatures, 13);
  assert.equal(h.emitterChain, 2);
  assert.equal(h.sequence, 123456789n);
  assert.equal(h.consistencyLevel, 15);
  assert.equal(h.emitterAddress, "0x" + "aa".repeat(32));
});

test("parseVaaHeader: skips the right number of signatures", () => {
  // A different signature count must still land on the body correctly.
  const h = parseVaaHeader(buildVaa({ gsi: 1, numSigs: 1, emitterChain: 5, sequence: 1n }));
  assert.equal(h.emitterChain, 5);
  assert.equal(h.sequence, 1n);
});

test("parseVaaHeader: rejects a too-short VAA", () => {
  assert.throws(() => parseVaaHeader("0x0100"), /too short/);
});

test("parseVaaHeader: rejects non-hex", () => {
  assert.throws(() => parseVaaHeader("0xZZ"), /non-hex/);
});

test("classifyWormhole: valid → verified, invalid → unverified with reason", () => {
  const ok = classifyWormhole(true, "");
  assert.equal(ok.status, "verified");
  assert.ok(ok.detail.some((d) => d.includes("guardian signatures are valid")));

  const bad = classifyWormhole(false, "VM signature invalid");
  assert.equal(bad.status, "unverified");
  assert.ok(bad.detail.some((d) => d.includes("VM signature invalid")));
});

test("classifyWormhole: includes header detail when provided", () => {
  const h = parseVaaHeader(buildVaa({ gsi: 7, numSigs: 1, emitterChain: 2, sequence: 9n }));
  const v = classifyWormhole(true, "", h);
  assert.ok(v.detail.some((d) => d.includes("sequence 9")));
});

test("classifyHyperlane: delivered true → verified, false → unverified", () => {
  assert.equal(classifyHyperlane(true).status, "verified");
  assert.equal(classifyHyperlane(false).status, "unverified");
});
