import { test } from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";
import { FREEZE_SELECTORS, classifyFreezeAuthority, classifyFreezeSurface } from "./freeze-core.js";

const push4 = (sel: string): string => `63${sel}`;
const dispatcher = (...sels: string[]): string => "0x" + sels.map(push4).join("5b");

const S = FREEZE_SELECTORS;
const EOA = "0x00000000000000000000000000000000000000A1";
const CONTRACT = "0x00000000000000000000000000000000000000C0";
const ZERO = "0x0000000000000000000000000000000000000000";

test("FREEZE_SELECTORS match keccak256 of their signatures", () => {
  const sigs: Record<keyof typeof FREEZE_SELECTORS, string> = {
    blacklist: "blacklist(address)",
    blacklister: "blacklister()",
    addBlackList: "addBlackList(address)",
    destroyBlackFunds: "destroyBlackFunds(address)",
  };
  for (const [k, sig] of Object.entries(sigs)) {
    assert.equal(`0x${FREEZE_SELECTORS[k as keyof typeof FREEZE_SELECTORS]}`, id(sig).slice(0, 10), sig);
  }
});

test("classifyFreezeSurface: FiatToken blacklist + blacklister()", () => {
  const s = classifyFreezeSurface(dispatcher(S.blacklist, S.blacklister));
  assert.equal(s.canFreeze, true);
  assert.equal(s.pattern, "fiattoken");
  assert.equal(s.hasBlacklisterGetter, true);
  assert.equal(s.canSeize, false);
});

test("classifyFreezeSurface: Tether addBlackList + destroyBlackFunds (seize)", () => {
  const s = classifyFreezeSurface(dispatcher(S.addBlackList, S.destroyBlackFunds));
  assert.equal(s.canFreeze, true);
  assert.equal(s.pattern, "tether");
  assert.equal(s.hasBlacklisterGetter, false);
  assert.equal(s.canSeize, true);
});

test("classifyFreezeSurface: no blacklist capability", () => {
  const s = classifyFreezeSurface(dispatcher("8da5cb5b")); // just owner()
  assert.equal(s.canFreeze, false);
  assert.equal(s.pattern, "none");
});

test("classifyFreezeAuthority: EOA blacklister → critical, fails CI", () => {
  const s = classifyFreezeSurface(dispatcher(S.blacklist, S.blacklister));
  const v = classifyFreezeAuthority(s, { address: EOA, kind: "eoa" });
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
  assert.ok(v.summary.includes("blacklister()"));
});

test("classifyFreezeAuthority: contract blacklister → elevated, no CI fail", () => {
  const s = classifyFreezeSurface(dispatcher(S.blacklist, S.blacklister));
  const v = classifyFreezeAuthority(s, { address: CONTRACT, kind: "contract" });
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
});

test("classifyFreezeAuthority: Tether owner-gated + seize → EOA is critical and mentions seize", () => {
  const s = classifyFreezeSurface(dispatcher(S.addBlackList, S.destroyBlackFunds));
  const v = classifyFreezeAuthority(s, { address: EOA, kind: "eoa" });
  assert.equal(v.risk, "critical");
  assert.ok(v.summary.includes("owner()"));
  assert.ok(v.summary.toLowerCase().includes("seize"));
});

test("classifyFreezeAuthority: renounced authority → info (can't freeze)", () => {
  const s = classifyFreezeSurface(dispatcher(S.blacklist, S.blacklister));
  const v = classifyFreezeAuthority(s, { address: ZERO, kind: "renounced" });
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyFreezeAuthority: unreadable authority → elevated, not a false critical", () => {
  const s = classifyFreezeSurface(dispatcher(S.blacklist, S.blacklister));
  const v = classifyFreezeAuthority(s, null);
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
});

test("classifyFreezeAuthority: no freeze capability → info", () => {
  const s = classifyFreezeSurface(dispatcher("8da5cb5b"));
  const v = classifyFreezeAuthority(s, null);
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});
