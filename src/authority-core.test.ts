import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAuthority } from "./authority-core.js";

const ADDR = "0x00000000000000000000000000000000000000A1";
const ZERO = "0x0000000000000000000000000000000000000000";

test("classifyAuthority: single EOA → critical, fails CI", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: true });
  assert.equal(v.kind, "eoa");
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
});

test("classifyAuthority: renounced (zero) → info, no fail", () => {
  const v = classifyAuthority({ address: ZERO, isZero: true });
  assert.equal(v.kind, "renounced");
  assert.equal(v.fail, false);
});

test("classifyAuthority: no authority found → unknown/info", () => {
  const v = classifyAuthority({ address: null });
  assert.equal(v.kind, "unknown");
  assert.equal(v.fail, false);
  assert.ok(v.summary.includes("AccessControl") || v.summary.includes("custom"));
});

test("classifyAuthority: 1-of-N Safe is effectively a single key → critical, fails", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 1, owners: 5 } });
  assert.equal(v.kind, "safe");
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
  assert.ok(v.summary.includes("1-of-5"));
});

test("classifyAuthority: healthy majority Safe (3-of-5) → info, no fail", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 3, owners: 5 } });
  assert.equal(v.kind, "safe");
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
  assert.ok(v.summary.includes("3-of-5"));
});

test("classifyAuthority: low-threshold Safe (2-of-5, Harmony-class) → elevated, no hard fail", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 2, owners: 5 } });
  assert.equal(v.kind, "safe");
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
  assert.ok(v.summary.toLowerCase().includes("low threshold"));
});

test("classifyAuthority: 2-of-3 Safe is below the floor → elevated", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 2, owners: 3 } });
  assert.equal(v.risk, "elevated");
});

test("classifyAuthority: minority-but-≥3 Safe (3-of-7) → elevated (not a majority)", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 3, owners: 7 } });
  assert.equal(v.risk, "elevated");
});

test("classifyAuthority: solid majority Safe (4-of-7) → info", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 4, owners: 7 } });
  assert.equal(v.risk, "info");
});

test("classifyAuthority: timelock with zero delay → elevated (no exit window)", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, timelock: { delaySec: 0 } });
  assert.equal(v.kind, "timelock");
  assert.equal(v.risk, "elevated");
  assert.ok(v.summary.includes("0"));
});

test("classifyAuthority: timelock below the floor → elevated", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false, timelock: { delaySec: 3600 }, minDelaySec: 24 * 3600 });
  assert.equal(v.kind, "timelock");
  assert.equal(v.risk, "elevated");
});

test("classifyAuthority: timelock at/above the floor → info", () => {
  const v = classifyAuthority({
    address: ADDR,
    isEoa: false,
    timelock: { delaySec: 48 * 3600 },
    minDelaySec: 24 * 3600,
  });
  assert.equal(v.kind, "timelock");
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyAuthority: unrecognized contract → elevated, inspect", () => {
  const v = classifyAuthority({ address: ADDR, isEoa: false });
  assert.equal(v.kind, "contract");
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
  assert.ok(v.summary.toLowerCase().includes("inspect"));
});

test("classifyAuthority: Safe takes precedence over the EOA flag", () => {
  // a contract that is a Safe should classify as safe, never eoa
  const v = classifyAuthority({ address: ADDR, isEoa: false, safe: { threshold: 2, owners: 3 } });
  assert.equal(v.kind, "safe");
});
