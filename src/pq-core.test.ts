import { test } from "node:test";
import assert from "node:assert/strict";
import { precompileCalls, detectSelectors, classifyScheme } from "./pq-core.js";

// Minimal bytecode snippets: PUSH <addr> ... CALL-family opcode.
// 0x60=PUSH1, 0x61=PUSH2, 0xfa=STATICCALL, 0xf1=CALL, 0x01=ADD.
const ECRECOVER = "0x6001fa"; // PUSH1 0x01, STATICCALL
const BN254_PAIR = "0x6008fa"; // PUSH1 0x08, STATICCALL
const BLS_2537 = "0x600cfa"; // PUSH1 0x0c, STATICCALL (EIP-2537 range)
const PQ_PRECOMPILE = "0x610101fa"; // PUSH2 0x0101, STATICCALL (ML-DSA-style)
const PUSH_NO_CALL = "0x600101"; // PUSH1 0x01 then ADD — constant 1, not a call
const STATICCALL_ONLY = "0xfa"; // call with no preceding address push
const FA_AS_IMMEDIATE = "0x60fa01"; // PUSH1 0xfa then ADD — 0xfa is data, not an opcode
const ERC1271 = "0x631626ba7e"; // PUSH4 isValidSignature(bytes32,bytes)

test("precompileCalls: detects ecrecover (0x01) near a call", () => {
  assert.deepEqual(precompileCalls(ECRECOVER), [1]);
});

test("precompileCalls: detects PQ precompile pushed as PUSH2", () => {
  assert.deepEqual(precompileCalls(PQ_PRECOMPILE), [0x0101]);
});

test("precompileCalls: a pushed constant with no following call is ignored", () => {
  assert.deepEqual(precompileCalls(PUSH_NO_CALL), []);
});

test("precompileCalls: a call with no address push finds nothing", () => {
  assert.deepEqual(precompileCalls(STATICCALL_ONLY), []);
});

test("precompileCalls: a 0xfa byte inside a PUSH immediate is not a STATICCALL", () => {
  // would wrongly fire if the walker didn't skip immediates
  assert.deepEqual(precompileCalls(FA_AS_IMMEDIATE), []);
});

test("precompileCalls: empty / EOA bytecode is safe", () => {
  assert.deepEqual(precompileCalls("0x"), []);
  assert.deepEqual(precompileCalls(""), []);
});

test("detectSelectors: finds ERC-1271 isValidSignature", () => {
  assert.deepEqual(detectSelectors(ERC1271), ["ERC-1271 isValidSignature(bytes32,bytes)"]);
});

test("classifyScheme: EOA → ECDSA, quantum-vulnerable, high confidence", () => {
  const v = classifyScheme({ bytecode: "0x", isEoa: true });
  assert.equal(v.scheme, "eoa");
  assert.equal(v.quantumVulnerable, true);
  assert.equal(v.confidence, "high");
});

test("classifyScheme: EIP-7702 delegated EOA → eoa, quantum-vulnerable, names delegate", () => {
  // 0xef0100 || 20-byte delegate
  const delegate = "1111111111111111111111111111111111111111";
  const v = classifyScheme({ bytecode: `0xef0100${delegate}` });
  assert.equal(v.scheme, "eoa");
  assert.equal(v.quantumVulnerable, true);
  assert.equal(v.confidence, "high");
  assert.ok(v.indicators.some((i) => i.includes("EIP-7702")));
  assert.ok(v.indicators.some((i) => i.includes("0x1111111111111111111111111111111111111111")));
});

test("classifyScheme: ecrecover → ecdsa, quantum-vulnerable", () => {
  const v = classifyScheme({ bytecode: ECRECOVER });
  assert.equal(v.scheme, "ecdsa");
  assert.equal(v.quantumVulnerable, true);
});

test("classifyScheme: bn254 pairing → bls-pairing, quantum-vulnerable", () => {
  const v = classifyScheme({ bytecode: BN254_PAIR });
  assert.equal(v.scheme, "bls-pairing");
  assert.equal(v.quantumVulnerable, true);
});

test("classifyScheme: EIP-2537 BLS precompile → bls-pairing", () => {
  const v = classifyScheme({ bytecode: BLS_2537 });
  assert.equal(v.scheme, "bls-pairing");
  assert.equal(v.quantumVulnerable, true);
});

test("classifyScheme: custom PQ precompile → pq, NOT quantum-vulnerable", () => {
  const v = classifyScheme({ bytecode: PQ_PRECOMPILE });
  assert.equal(v.scheme, "pq");
  assert.equal(v.quantumVulnerable, false);
});

test("classifyScheme: a quantum-vulnerable indicator dominates a PQ one", () => {
  // verifier that calls BOTH ecrecover and a PQ precompile → still vulnerable
  const hybrid = "0x6001fa610101fa";
  const v = classifyScheme({ bytecode: hybrid });
  assert.equal(v.quantumVulnerable, true);
});

test("classifyScheme: signature interface but no scheme evidence → unknown vulnerability", () => {
  const v = classifyScheme({ bytecode: ERC1271 });
  assert.equal(v.scheme, "sig-interface");
  assert.equal(v.quantumVulnerable, null);
});

test("classifyScheme: nothing recognizable → unknown", () => {
  const v = classifyScheme({ bytecode: "0x60806040" });
  assert.equal(v.scheme, "unknown");
  assert.equal(v.quantumVulnerable, null);
});
