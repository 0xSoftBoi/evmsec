import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCompilerBugs, extractSolcVersion } from "./compiler-core.js";

// Precomputed CBOR metadata trailers (see scripts: a1 64 "solc" <tag> <ver> + 2-byte len).
const RELEASE_0_8_34 = "0x6001a164736f6c6343000822000a";
const NIGHTLY_0_5_0 = "0x6001a164736f6c636d302e352e302d646576656c6f700014";

test("extractSolcVersion: reads a release version from the 3-byte tag", () => {
  const v = extractSolcVersion(RELEASE_0_8_34);
  assert.equal(v.version, "0.8.34");
  assert.equal(v.isRelease, true);
});

test("extractSolcVersion: reads a nightly/prerelease version from the text string", () => {
  const v = extractSolcVersion(NIGHTLY_0_5_0);
  assert.equal(v.version, "0.5.0");
  assert.equal(v.isRelease, false);
});

test("extractSolcVersion: empty / no-metadata bytecode → null", () => {
  assert.equal(extractSolcVersion("0x").version, null);
  assert.equal(extractSolcVersion("0x6001600101").version, null);
});

test("classifyCompilerBugs: a version with a high-severity unconditional bug → critical, fails CI", () => {
  // 0.1.0 carries high-severity bugs that apply unconditionally in the published list.
  const v = classifyCompilerBugs({ version: "0.1.0", isRelease: true });
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
  assert.ok(v.bugs.length > 0);
});

test("classifyCompilerBugs: a clean recent version → info, no fail", () => {
  const v = classifyCompilerBugs({ version: "0.8.34", isRelease: true });
  assert.equal(v.knownVersion, true);
  assert.equal(v.bugs.length, 0);
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyCompilerBugs: a version outside the bundled table → knownVersion false, info", () => {
  const v = classifyCompilerBugs({ version: "9.9.9", isRelease: true });
  assert.equal(v.knownVersion, false);
  assert.equal(v.fail, false);
});

test("classifyCompilerBugs: no version found → info, no fail", () => {
  const v = classifyCompilerBugs({ version: null, isRelease: false });
  assert.equal(v.fail, false);
  assert.ok(v.summary.toLowerCase().includes("no solc version"));
});

test("classifyCompilerBugs: matched bugs carry their severity + link (citable)", () => {
  const v = classifyCompilerBugs({ version: "0.1.0", isRelease: true });
  for (const b of v.bugs) {
    assert.ok(typeof b.severity === "string" && b.severity.length > 0);
    assert.ok(b.link === undefined || b.link.startsWith("http"));
    assert.ok(typeof b.conditional === "boolean");
  }
});
