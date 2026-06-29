import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistry } from "./registry-core.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // checksummed
const ESC = "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf";
const POLY = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

function route(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "eth-usdc-polygon",
    bridge: "Test Bridge",
    asset: "USDC",
    lock: { chain: "ethereum", escrow: ESC, token: USDC },
    mint: { chain: "polygon", token: POLY },
    verified: false,
    ...over,
  };
}

test("validateRegistry: a well-formed illustrative route passes", () => {
  const r = validateRegistry({ routes: [route()] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.routeCount, 1);
});

test("validateRegistry: top-level shape is enforced", () => {
  assert.ok(validateRegistry({}).errors.length > 0);
  assert.ok(validateRegistry({ routes: "nope" }).errors.length > 0);
  assert.ok(validateRegistry(null).errors.length > 0);
});

test("validateRegistry: unknown chain is an error", () => {
  const r = validateRegistry({ routes: [route({ lock: { chain: "solana", escrow: ESC, token: USDC } })] });
  assert.ok(r.errors.some((e) => e.includes("unknown chain")));
});

test("validateRegistry: a non-checksummed address is an error", () => {
  const lower = USDC.toLowerCase();
  const r = validateRegistry({ routes: [route({ lock: { chain: "ethereum", escrow: ESC, token: lower } })] });
  assert.ok(r.errors.some((e) => e.includes("checksummed")));
});

test("validateRegistry: a malformed address is an error", () => {
  const r = validateRegistry({ routes: [route({ lock: { chain: "ethereum", escrow: ESC, token: "0xnope" } })] });
  assert.ok(r.errors.some((e) => e.includes("not a valid address")));
});

test("validateRegistry: duplicate ids are an error", () => {
  const r = validateRegistry({ routes: [route(), route()] });
  assert.ok(r.errors.some((e) => e.includes("duplicate id")));
});

test("validateRegistry: non-kebab id is an error", () => {
  const r = validateRegistry({ routes: [route({ id: "Eth_USDC" })] });
  assert.ok(r.errors.some((e) => e.includes("kebab-case")));
});

test("validateRegistry: a verified route must cite a source URL", () => {
  const noSource = validateRegistry({ routes: [route({ verified: true, notes: "trust me" })] });
  assert.ok(noSource.errors.some((e) => e.includes("primary-source URL")));

  const withSource = validateRegistry({
    routes: [route({ verified: true, notes: "see https://docs.example/bridge" })],
  });
  assert.deepEqual(withSource.errors, []);

  const missingNotes = validateRegistry({ routes: [route({ verified: true, notes: undefined })] });
  assert.ok(missingNotes.errors.some((e) => e.includes("cite a primary source")));
});

test("validateRegistry: multi-leg lock is validated per leg", () => {
  const r = validateRegistry({
    routes: [
      route({
        lock: [
          { chain: "ethereum", escrow: ESC, token: USDC },
          { chain: "bogus", escrow: ESC, token: USDC },
        ],
      }),
    ],
  });
  assert.ok(r.errors.some((e) => e.includes("lock[1]") && e.includes("unknown chain")));
});

test("validateRegistry: missing required fields are reported", () => {
  const r = validateRegistry({ routes: [{ id: "x" }] });
  assert.ok(r.errors.some((e) => e.includes('missing "bridge"')));
  assert.ok(r.errors.some((e) => e.includes('missing "lock"')));
  assert.ok(r.errors.some((e) => e.includes('missing "mint"')));
});
