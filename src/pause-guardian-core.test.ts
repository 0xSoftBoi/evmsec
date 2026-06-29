import { test } from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";
import { PAUSE_SELECTORS, classifyPauseSurface, classifyPauseGuardian } from "./pause-guardian-core.js";

const push4 = (sel: string): string => `63${sel}`;
const dispatcher = (...sels: string[]): string => "0x" + sels.map(push4).join("5b");

const PAUSE = PAUSE_SELECTORS.pause;
const PAUSED = PAUSE_SELECTORS.paused;
const OWNER = PAUSE_SELECTORS.owner;
const HAS_ROLE = PAUSE_SELECTORS.hasRole;

test("PAUSE_SELECTORS match keccak256 of their signatures", () => {
  const sigs: Record<keyof typeof PAUSE_SELECTORS, string> = {
    pause: "pause()",
    unpause: "unpause()",
    paused: "paused()",
    owner: "owner()",
    hasRole: "hasRole(bytes32,address)",
    grantRole: "grantRole(bytes32,address)",
  };
  for (const [k, sig] of Object.entries(sigs)) {
    assert.equal(`0x${PAUSE_SELECTORS[k as keyof typeof PAUSE_SELECTORS]}`, id(sig).slice(0, 10), sig);
  }
});

test("classifyPauseSurface: pausable + ownable", () => {
  const s = classifyPauseSurface(dispatcher(PAUSE, PAUSED, OWNER));
  assert.equal(s.pausable, true);
  assert.equal(s.hasPausedView, true);
  assert.equal(s.authModel, "ownable");
});

test("classifyPauseSurface: pausable + access-control", () => {
  const s = classifyPauseSurface(dispatcher(PAUSE, HAS_ROLE));
  assert.equal(s.pausable, true);
  assert.equal(s.authModel, "access-control");
});

test("classifyPauseSurface: not pausable", () => {
  const s = classifyPauseSurface(dispatcher(OWNER));
  assert.equal(s.pausable, false);
});

test("classifyPauseGuardian: pausable + EOA owner → critical, fails CI", () => {
  const s = classifyPauseSurface(dispatcher(PAUSE, OWNER));
  const v = classifyPauseGuardian(s, false, "eoa", "0x00000000000000000000000000000000000000A1");
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
});

test("classifyPauseGuardian: pausable + contract owner → elevated", () => {
  const s = classifyPauseSurface(dispatcher(PAUSE, OWNER));
  const v = classifyPauseGuardian(s, false, "contract", "0x00000000000000000000000000000000000000C0");
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
});

test("classifyPauseGuardian: AccessControl with an EOA pauser → critical", () => {
  const s = classifyPauseSurface(dispatcher(PAUSE, HAS_ROLE));
  const v = classifyPauseGuardian(s, false, "unknown", null, [
    { address: "0x00000000000000000000000000000000000000A1", kind: "eoa" },
  ]);
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
});

test("classifyPauseGuardian: not pausable → info, no fail", () => {
  const s = classifyPauseSurface(dispatcher(OWNER));
  const v = classifyPauseGuardian(s, null, "eoa", "0x00000000000000000000000000000000000000A1");
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyPauseGuardian: currently paused is surfaced in the summary", () => {
  const s = classifyPauseSurface(dispatcher(PAUSE, OWNER));
  const v = classifyPauseGuardian(s, true, "contract", "0x00000000000000000000000000000000000000C0");
  assert.ok(v.summary.includes("CURRENTLY PAUSED"));
});
