import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDeps } from "./deps-core.js";

const CHAINS = ["ethereum", "base", "polygon"];
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

test("validateDeps: a well-formed manifest yields deps, no errors", () => {
  const v = validateDeps({ dependencies: [{ label: "USDC", chain: "ethereum", address: USDC }] }, CHAINS);
  assert.equal(v.errors.length, 0);
  assert.equal(v.deps.length, 1);
  assert.equal(v.deps[0].label, "USDC");
  assert.equal(v.deps[0].chain, "ethereum");
});

test("validateDeps: label defaults to the address when omitted", () => {
  const v = validateDeps({ dependencies: [{ chain: "ethereum", address: USDC }] }, CHAINS);
  assert.equal(v.errors.length, 0);
  assert.equal(v.deps[0].label, USDC);
});

test("validateDeps: rejects a non-object / missing dependencies array", () => {
  assert.ok(validateDeps(null, CHAINS).errors.length > 0);
  assert.ok(validateDeps({}, CHAINS).errors.length > 0);
  assert.ok(validateDeps({ dependencies: {} }, CHAINS).errors.length > 0);
});

test("validateDeps: flags an unknown chain", () => {
  const v = validateDeps({ dependencies: [{ chain: "fantom", address: USDC }] }, CHAINS);
  assert.ok(v.errors.some((e) => e.includes("unknown chain")));
  assert.equal(v.deps.length, 0);
});

test("validateDeps: flags a malformed address", () => {
  const v = validateDeps({ dependencies: [{ chain: "ethereum", address: "0xnope" }] }, CHAINS);
  assert.ok(v.errors.some((e) => e.includes("invalid address")));
});

test("validateDeps: reports each bad entry but keeps the good ones", () => {
  const v = validateDeps(
    { dependencies: [{ chain: "ethereum", address: USDC }, { chain: "mars", address: USDC }, "nope"] },
    CHAINS,
  );
  assert.equal(v.deps.length, 1); // only the valid entry
  assert.ok(v.errors.length >= 2); // the unknown chain + the non-object
});

test("validateDeps: an empty dependencies list is an error, not silent success", () => {
  const v = validateDeps({ dependencies: [] }, CHAINS);
  assert.ok(v.errors.length > 0);
});
