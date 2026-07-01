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

test("classifyVerification: no match, no Etherscan → unverified, elevated, fails CI", () => {
  const v = classifyVerification({ match: null, reachable: true });
  assert.equal(v.status, "unverified");
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, true);
  assert.equal(v.provider, "none");
});

test("classifyVerification: Sourcify unreachable, no Etherscan → unknown, no fail", () => {
  const v = classifyVerification({ match: null, reachable: false });
  assert.equal(v.status, "unknown");
  assert.equal(v.fail, false);
});

test("classifyVerification: Sourcify misses but Etherscan verified → verified, no fail", () => {
  const v = classifyVerification({ match: null, reachable: true, etherscan: "verified" });
  assert.equal(v.status, "verified");
  assert.equal(v.provider, "etherscan");
  assert.equal(v.fail, false);
  assert.ok(v.summary.toLowerCase().includes("etherscan"));
});

test("classifyVerification: Sourcify positive match wins even if Etherscan skipped", () => {
  const v = classifyVerification({ match: "exact_match", reachable: true, etherscan: undefined });
  assert.equal(v.status, "exact");
  assert.equal(v.provider, "sourcify");
});

test("classifyVerification: both providers say unverified → unverified, fails CI", () => {
  const v = classifyVerification({ match: null, reachable: true, etherscan: "unverified" });
  assert.equal(v.status, "unverified");
  assert.equal(v.fail, true);
});

test("classifyVerification: Sourcify down but Etherscan rescues → verified, no fail", () => {
  const v = classifyVerification({ match: null, reachable: false, etherscan: "verified" });
  assert.equal(v.status, "verified");
  assert.equal(v.fail, false);
});

test("classifyVerification: Sourcify down, Etherscan says unverified → unverified, fails CI", () => {
  const v = classifyVerification({ match: null, reachable: false, etherscan: "unverified" });
  assert.equal(v.status, "unverified");
  assert.equal(v.fail, true);
});

test("classifyVerification: both providers unreachable → unknown, no fail", () => {
  const v = classifyVerification({ match: null, reachable: false, etherscan: "unreachable" });
  assert.equal(v.status, "unknown");
  assert.equal(v.fail, false);
});
