import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVerification } from "./verification-core.js";

test("classifyVerification: exact match → verified, info, no fail", () => {
  const v = classifyVerification({ match: "exact_match", reachable: true });
  assert.equal(v.status, "exact");
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyVerification: partial match → verified (partial), info, no fail", () => {
  const v = classifyVerification({ match: "match", reachable: true });
  assert.equal(v.status, "partial");
  assert.equal(v.fail, false);
  assert.ok(v.summary.toLowerCase().includes("partial"));
});

test("classifyVerification: no match → unverified, elevated, fails CI", () => {
  const v = classifyVerification({ match: null, reachable: true });
  assert.equal(v.status, "unverified");
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, true);
});

test("classifyVerification: provider unreachable → unknown, no fail (not a verdict)", () => {
  const v = classifyVerification({ match: null, reachable: false });
  assert.equal(v.status, "unknown");
  assert.equal(v.fail, false);
});
