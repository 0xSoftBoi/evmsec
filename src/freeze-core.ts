/**
 * Freeze / blacklist authority — pure logic, no network.
 *
 * `pause-guardian` answers "can *all* transfers be frozen at once?". This answers
 * the sibling censorship question: **can a specific holder be frozen (or their
 * balance seized) individually, and who holds that power?** It's a distinct, real
 * vector — the FiatToken family (USDC-class) has a `blacklister` role that can
 * `blacklist(addr)`, and Tether (USDT) has an owner-gated `addBlackList` plus a
 * `destroyBlackFunds` that *burns* a blacklisted balance.
 *
 * Like the others this is a bytecode + on-chain-read heuristic. It classifies the
 * surface here; the command resolves the authority (FiatToken `blacklister()`, or
 * the owner for the Tether pattern) and this folds it into a verdict.
 */

import { RoleHolder } from "./mint-authority-core.js";

const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;

// Verified in the unit test by recomputing from signatures.
const SEL = {
  blacklist: "f9f92be4", // blacklist(address)         — FiatToken
  blacklister: "bd102430", // blacklister()             — FiatToken role getter
  isBlacklisted: "fe575a87", // isBlacklisted(address)  — FiatToken
  addBlackList: "0ecb93c0", // addBlackList(address)    — Tether (owner-gated)
  isBlackListed: "e47d6060", // isBlackListed(address)  — Tether
  destroyBlackFunds: "f3bdc228", // destroyBlackFunds(address) — Tether (seize/burn)
} as const;
export const FREEZE_SELECTORS = SEL;

function selectorsPresent(bytecode: string, wanted: Set<string>): Set<string> {
  const found = new Set<string>();
  if (!bytecode || bytecode === "0x") return found;
  const hex = bytecode.toLowerCase().replace(/^0x/, "");
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === PUSH4) {
      let sel = "";
      for (let j = 1; j <= 4 && i + j < bytes.length; j++) sel += bytes[i + j].toString(16).padStart(2, "0");
      if (sel.length === 8 && wanted.has(sel)) found.add(sel);
      i += 4;
    } else if (op >= PUSH1 && op <= PUSH32) {
      i += op - PUSH1 + 1;
    }
  }
  return found;
}

/** `fiattoken` = blacklister-gated blacklist; `tether` = owner-gated addBlackList. */
export type FreezePattern = "fiattoken" | "tether" | "none";

export interface FreezeSurface {
  /** a targeted freeze / blacklist capability was detected. */
  canFreeze: boolean;
  pattern: FreezePattern;
  /** FiatToken `blacklister()` getter — the authority is that role, not owner(). */
  hasBlacklisterGetter: boolean;
  /** a blacklisted holder's balance can be *seized/burned* (Tether destroyBlackFunds). */
  canSeize: boolean;
  indicators: string[];
}

/** Detect the targeted-freeze surface from deployed bytecode. Pure. */
export function classifyFreezeSurface(bytecode: string): FreezeSurface {
  const present = selectorsPresent(bytecode, new Set(Object.values(SEL)));
  const fiatToken = present.has(SEL.blacklist);
  const tether = present.has(SEL.addBlackList);
  const hasBlacklisterGetter = present.has(SEL.blacklister);
  const canSeize = present.has(SEL.destroyBlackFunds);

  const pattern: FreezePattern = fiatToken ? "fiattoken" : tether ? "tether" : "none";
  const canFreeze = pattern !== "none";

  const indicators: string[] = [];
  if (!canFreeze) indicators.push("no targeted freeze / blacklist function detected in bytecode");
  else if (pattern === "fiattoken")
    indicators.push("FiatToken blacklist(address) present — a blacklister can freeze any holder");
  else indicators.push("Tether addBlackList(address) present — the owner can freeze any holder");
  if (canSeize) indicators.push("destroyBlackFunds(address) present — a frozen holder's balance can be burned/seized");

  return { canFreeze, pattern, hasBlacklisterGetter, canSeize, indicators };
}

export type FreezeRisk = "critical" | "elevated" | "info";

export interface FreezeVerdict {
  surface: FreezeSurface;
  /** the resolved freeze authority (FiatToken blacklister(), or the owner for Tether). */
  authority: RoleHolder | null;
  risk: FreezeRisk;
  /** true when CI should fail: a single EOA can freeze/seize any holder. */
  fail: boolean;
  summary: string;
}

/**
 * Fold the freeze surface + resolved authority into a verdict. The sharp signal:
 * a token where a single EOA can freeze (and sometimes seize) any holder's
 * balance. As with the admin/pause keys, this is the *on-chain* authority —
 * off-chain custody of that key is not observable here.
 */
export function classifyFreezeAuthority(surface: FreezeSurface, authority: RoleHolder | null): FreezeVerdict {
  const verb = surface.canSeize ? "freeze or seize" : "freeze";
  let risk: FreezeRisk = "info";
  let summary: string;
  let fail = false;

  if (!surface.canFreeze) {
    return {
      surface,
      authority,
      risk: "info",
      fail: false,
      summary:
        "no targeted freeze / blacklist capability detected — individual holders can't be frozen via a known pattern (confirm from source).",
    };
  }

  const who = surface.hasBlacklisterGetter ? "blacklister()" : "owner()";

  if (!authority) {
    risk = "elevated";
    summary = `token can ${verb} individual holders (${surface.pattern}), but the freeze authority (${who}) couldn't be read — resolve and verify it.`;
  } else if (authority.kind === "renounced") {
    risk = "info";
    summary = `freeze authority (${who}) is the zero address — the blacklist can't be invoked; unusual for a freeze-capable token, so confirm there is no other path.`;
  } else if (authority.kind === "eoa") {
    risk = "critical";
    fail = true;
    summary = `a single EOA (${authority.address}) can ${verb} any holder's balance via ${who} — one key holds targeted-censorship power over every account.`;
  } else {
    risk = "elevated";
    summary = `the freeze authority (${who}) is a contract (${authority.address}) — likely a controller/multisig; inspect it. It can ${verb} any holder.`;
  }

  return { surface, authority, risk, fail, summary };
}
