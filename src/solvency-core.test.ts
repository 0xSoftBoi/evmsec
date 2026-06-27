import { test } from "node:test";
import assert from "node:assert/strict";
import { sumLocked18, isRouteFailing, computeTransitions } from "./solvency-core.js";

test("sumLocked18: sums legs normalized to 18 dp", () => {
  const one = 10n ** 18n;
  // 1 USDC (6dp) + 1 DAI (18dp) + 1 unit (0dp) = 3e18
  const total = sumLocked18([
    { raw: 1_000_000n, decimals: 6 },
    { raw: one, decimals: 18 },
    { raw: 1n, decimals: 0 },
  ]);
  assert.equal(total, 3n * one);
});

test("sumLocked18: empty legs sum to zero", () => {
  assert.equal(sumLocked18([]), 0n);
});

test("isRouteFailing: breach, error, and below-threshold all fail", () => {
  assert.equal(isRouteFailing({ verdict: "UNDERCOLLATERALIZED", ratioPct: 80 }, 100), true);
  assert.equal(isRouteFailing({ verdict: "ERROR", ratioPct: null }, 100), true);
  assert.equal(isRouteFailing({ verdict: "BACKED", ratioPct: 99.9 }, 100), true); // below threshold
  assert.equal(isRouteFailing({ verdict: "BACKED", ratioPct: 100 }, 100), false);
  assert.equal(isRouteFailing({ verdict: "NO_SUPPLY", ratioPct: null }, 100), false);
});

test("computeTransitions: first-seen failing is a breach", () => {
  const t = computeTransitions(new Map(), [{ id: "a", failing: true }]);
  assert.deepEqual(t, [{ id: "a", kind: "breach" }]);
});

test("computeTransitions: first-seen healthy is silent", () => {
  const t = computeTransitions(new Map(), [{ id: "a", failing: false }]);
  assert.deepEqual(t, []);
});

test("computeTransitions: steady breach does not re-alert", () => {
  const prev = new Map([["a", true]]);
  const t = computeTransitions(prev, [{ id: "a", failing: true }]);
  assert.deepEqual(t, []);
});

test("computeTransitions: recovery fires once", () => {
  const prev = new Map([["a", true]]);
  const t = computeTransitions(prev, [{ id: "a", failing: false }]);
  assert.deepEqual(t, [{ id: "a", kind: "recovery" }]);
});

test("computeTransitions: healthy → breach fires", () => {
  const prev = new Map([["a", false]]);
  const t = computeTransitions(prev, [{ id: "a", failing: true }]);
  assert.deepEqual(t, [{ id: "a", kind: "breach" }]);
});

test("computeTransitions: handles a mix across routes", () => {
  const prev = new Map([
    ["a", true],
    ["b", false],
    ["c", true],
  ]);
  const t = computeTransitions(prev, [
    { id: "a", failing: false }, // recovery
    { id: "b", failing: true }, // breach
    { id: "c", failing: true }, // steady — silent
    { id: "d", failing: true }, // first-seen breach
  ]);
  assert.deepEqual(t, [
    { id: "a", kind: "recovery" },
    { id: "b", kind: "breach" },
    { id: "d", kind: "breach" },
  ]);
});
