import { test } from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";
import { MINT_SELECTORS, scanSelectors, classifyMintSurface, classifyMintAuthority } from "./mint-authority-core.js";

// Build bytecode fragments: PUSH4 <selector> for each known function, glued
// together with a JUMPDEST (0x5b) — a stand-in for a real dispatcher table.
const push4 = (sel: string): string => `63${sel}`;
const dispatcher = (...sels: string[]): string => "0x" + sels.map(push4).join("5b");

const MINT = "40c10f19"; // mint(address,uint256)
const OWNER = "8da5cb5b"; // owner()
const HAS_ROLE = "91d14854"; // hasRole(bytes32,address)
const PAUSE = "5c975abb"; // paused()
const BURN = "42966c68"; // burn(uint256)

test("MINT_SELECTORS values match keccak256 of their signatures (can't silently rot)", () => {
  for (const k of MINT_SELECTORS) {
    // strip any trailing " (note)" annotation to recover the bare signature
    const signature = k.label.replace(/ \(.*\)$/, "");
    assert.equal(`0x${k.selector}`, id(signature).slice(0, 10), `selector for ${k.label}`);
  }
});

test("scanSelectors: finds mint(address,uint256) in a dispatcher", () => {
  const hits = scanSelectors(dispatcher(MINT)).map((h) => h.selector);
  assert.deepEqual(hits, [MINT]);
});

test("scanSelectors: a selector buried inside a PUSH immediate is not a dispatch entry", () => {
  // PUSH32 (0x7f) followed by 32 bytes that contain 0x40c10f19 — must be skipped
  const bc = "0x7f" + MINT + "00".repeat(28);
  assert.deepEqual(scanSelectors(bc), []);
});

test("scanSelectors: empty / EOA bytecode is safe", () => {
  assert.deepEqual(scanSelectors("0x"), []);
  assert.deepEqual(scanSelectors(""), []);
});

test("classifyMintSurface: mintable + ownable token", () => {
  const s = classifyMintSurface(dispatcher(MINT, OWNER));
  assert.equal(s.mintable, true);
  assert.equal(s.authModel, "ownable");
  assert.ok(s.mintEntrypoints.includes("mint(address,uint256)"));
});

test("classifyMintSurface: AccessControl + mint detected", () => {
  const s = classifyMintSurface(dispatcher(MINT, HAS_ROLE));
  assert.equal(s.mintable, true);
  assert.equal(s.authModel, "access-control");
});

test("classifyMintSurface: ownable + access-control combined", () => {
  const s = classifyMintSurface(dispatcher(MINT, OWNER, HAS_ROLE));
  assert.equal(s.authModel, "ownable+access-control");
});

test("classifyMintSurface: pausable and burnable flags", () => {
  const s = classifyMintSurface(dispatcher(MINT, PAUSE, BURN));
  assert.equal(s.pausable, true);
  assert.equal(s.burnable, true);
});

test("classifyMintSurface: no mint entrypoint → not mintable", () => {
  const s = classifyMintSurface(dispatcher(OWNER, PAUSE));
  assert.equal(s.mintable, false);
  assert.ok(s.indicators.some((i) => i.includes("no recognized mint entrypoint")));
});

test("classifyMintAuthority: mintable + EOA owner → critical, fails CI", () => {
  const s = classifyMintSurface(dispatcher(MINT, OWNER));
  const v = classifyMintAuthority(s, "eoa", "0x00000000000000000000000000000000000000A1");
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
  assert.ok(v.summary.includes("single EOA"));
});

test("classifyMintAuthority: mintable + contract owner → elevated, no CI fail", () => {
  const s = classifyMintSurface(dispatcher(MINT, OWNER));
  const v = classifyMintAuthority(s, "contract", "0x00000000000000000000000000000000000000C0");
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
});

test("classifyMintAuthority: mintable + renounced ownership → info", () => {
  const s = classifyMintSurface(dispatcher(MINT, OWNER));
  const v = classifyMintAuthority(s, "renounced", null);
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyMintAuthority: AccessControl, holders not resolved → elevated", () => {
  const s = classifyMintSurface(dispatcher(MINT, HAS_ROLE));
  const v = classifyMintAuthority(s, "unknown", null); // minters undefined
  assert.equal(v.risk, "elevated");
  assert.ok(v.summary.includes("couldn't be enumerated"));
});

test("classifyMintAuthority: AccessControl with an EOA minter → critical, fails CI", () => {
  const s = classifyMintSurface(dispatcher(MINT, HAS_ROLE));
  const v = classifyMintAuthority(s, "unknown", null, [
    { address: "0x00000000000000000000000000000000000000A1", kind: "eoa" },
    { address: "0x00000000000000000000000000000000000000C0", kind: "contract" },
  ]);
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
  assert.ok(v.summary.includes("EOA"));
});

test("classifyMintAuthority: AccessControl, all minters are contracts → elevated", () => {
  const s = classifyMintSurface(dispatcher(MINT, HAS_ROLE));
  const v = classifyMintAuthority(s, "unknown", null, [
    { address: "0x00000000000000000000000000000000000000C0", kind: "contract" },
  ]);
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
  assert.ok(v.summary.includes("all contracts"));
});

test("classifyMintAuthority: AccessControl with zero current minters → info", () => {
  const s = classifyMintSurface(dispatcher(MINT, HAS_ROLE));
  const v = classifyMintAuthority(s, "unknown", null, []);
  assert.equal(v.risk, "info");
  assert.ok(v.summary.includes("no address currently holds MINTER_ROLE"));
});

test("classifyMintSurface: supply cap getter sets capped", () => {
  const CAP = "355274ea"; // cap()
  const s = classifyMintSurface(dispatcher(MINT, CAP));
  assert.equal(s.capped, true);
});

test("classifyMintAuthority: cap is noted in the summary when present", () => {
  const CAP = "355274ea";
  const s = classifyMintSurface(dispatcher(MINT, OWNER, CAP));
  const v = classifyMintAuthority(s, "eoa", "0x00000000000000000000000000000000000000A1");
  assert.ok(v.summary.includes("bounded by a supply cap"));
});

test("classifyMintAuthority: no mint entrypoint → info, no fail", () => {
  const s = classifyMintSurface(dispatcher(OWNER));
  const v = classifyMintAuthority(s, "eoa", "0x00000000000000000000000000000000000000A1");
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});
