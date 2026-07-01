/**
 * Pause-guardian classification — pure logic, no network.
 *
 * Many bridge tokens are Pausable: a guardian can freeze all transfers. That is
 * a real liveness / censorship vector — if a single key can pause a wrapped
 * asset, it can halt every holder at once. This asks: **is this token pausable,
 * is it paused right now, and who holds the pause authority?**
 *
 * Like the other checks it's a bytecode + on-chain-read heuristic: it spots the
 * pause entrypoints and the auth model, and the command resolves the guardian
 * (Ownable `owner()` or AccessControl `PAUSER_ROLE` holders). Confirm gating
 * against source.
 */

import { selectorsPresent } from "./lib.js";
import { AuthModel, OwnerKind, RoleHolder } from "./mint-authority-core.js";

// Verified in the unit test by recomputing from signatures.
const SEL = {
  pause: "8456cb59", // pause()
  unpause: "3f4ba83a", // unpause()
  paused: "5c975abb", // paused()
  owner: "8da5cb5b", // owner()
  pauser: "9fd0506d", // pauser() — FiatToken-style single-address pause role
  hasRole: "91d14854", // hasRole(bytes32,address)
  grantRole: "2f2ff15d", // grantRole(bytes32,address)
} as const;
export const PAUSE_SELECTORS = SEL;

export interface PauseSurface {
  /** has pause() and/or unpause() — transfers can be frozen. */
  pausable: boolean;
  /** exposes a paused() view (Pausable). */
  hasPausedView: boolean;
  /** a FiatToken-style `pauser()` getter — pausing is gated by that role, not owner(). */
  hasPauserGetter: boolean;
  authModel: AuthModel;
  indicators: string[];
}

/** Classify the pause capability surface of a token from its deployed bytecode. */
export function classifyPauseSurface(bytecode: string): PauseSurface {
  const present = selectorsPresent(bytecode, new Set(Object.values(SEL)));
  const pausable = present.has(SEL.pause) || present.has(SEL.unpause);
  const hasPausedView = present.has(SEL.paused);
  const hasPauserGetter = present.has(SEL.pauser);
  const ownable = present.has(SEL.owner);
  const accessControl = present.has(SEL.hasRole) || present.has(SEL.grantRole);

  const authModel: AuthModel =
    ownable && accessControl
      ? "ownable+access-control"
      : accessControl
        ? "access-control"
        : ownable
          ? "ownable"
          : "none-detected";

  const indicators: string[] = [];
  if (pausable) indicators.push("pause()/unpause() entrypoint present — transfers can be frozen");
  else if (hasPausedView)
    indicators.push("paused() view present but no pause() entrypoint found — confirm from source");
  else indicators.push("no pause mechanism detected in bytecode");
  if (hasPauserGetter) indicators.push("FiatToken pauser() present — pausing is gated by the pauser, not owner()");
  else if (accessControl) indicators.push("AccessControl — pausing is likely gated by PAUSER_ROLE");
  if (ownable && !hasPauserGetter) indicators.push("Ownable owner() present — pausing may be gated by a single owner");

  return { pausable, hasPausedView, hasPauserGetter, authModel, indicators };
}

export type PauseRisk = "critical" | "elevated" | "info";

export interface PauseGuardianVerdict {
  surface: PauseSurface;
  /** current paused state, if the command could read it. */
  paused: boolean | null;
  guardianKind: OwnerKind;
  guardian: string | null;
  /** resolved PAUSER_ROLE holders, when the token uses AccessControl. */
  pausers?: RoleHolder[];
  /** resolved FiatToken-style pauser(), when present — this, not owner(), gates pausing. */
  pauser?: RoleHolder | null;
  risk: PauseRisk;
  /** true when CI should fail: a single key can freeze all transfers. */
  fail: boolean;
  summary: string;
}

/**
 * Fold the pause surface + the resolved guardian into a risk verdict. The sharp
 * signal is a *pausable* token whose pause authority is a single EOA — one key
 * can freeze every holder. A currently-paused token is flagged prominently
 * regardless of who holds the key.
 */
export function classifyPauseGuardian(
  surface: PauseSurface,
  paused: boolean | null,
  guardianKind: OwnerKind,
  guardian: string | null,
  pausers?: RoleHolder[],
  pauser?: RoleHolder | null,
): PauseGuardianVerdict {
  const isAccessControl = surface.authModel === "access-control" || surface.authModel === "ownable+access-control";
  const pausedPrefix = paused === true ? "⚠ token is CURRENTLY PAUSED — transfers are frozen. " : "";
  let risk: PauseRisk = "info";
  let summary: string;
  let fail = false;

  if (!surface.pausable) {
    risk = "info";
    summary = `${pausedPrefix}no pause entrypoint detected — transfers can't be frozen via a standard Pausable interface; confirm from source.`;
    return { surface, paused, guardianKind, guardian, pausers, pauser, risk, fail, summary };
  }

  // FiatToken (USDC-class): pausing is gated by pauser(), NOT owner(). Resolve and
  // classify that address — pointing at owner() here would misattribute the key.
  if (surface.hasPauserGetter) {
    if (!pauser) {
      risk = "elevated";
      summary = `${pausedPrefix}pausing is gated by a FiatToken-style pauser() that couldn't be read — resolve and verify it is a controller/multisig.`;
    } else if (pauser.kind === "renounced") {
      risk = "info";
      summary = `${pausedPrefix}pauser() is the zero address — pausing can't be triggered via the pauser role; confirm there is no other pause path.`;
    } else if (pauser.kind === "eoa") {
      risk = "critical";
      fail = true;
      summary = `${pausedPrefix}pausing is gated by pauser() held by a single EOA (${pauser.address}) — one key can freeze all transfers.`;
    } else {
      risk = "elevated";
      summary = `${pausedPrefix}pausing is gated by a pauser() contract (${pauser.address}) — likely a controller/multisig; inspect it.`;
    }
    return { surface, paused, guardianKind, guardian, pausers, pauser, risk, fail, summary };
  }

  if (isAccessControl) {
    const eoaPausers = (pausers ?? []).filter((p) => p.kind === "eoa");
    if (eoaPausers.length) {
      risk = "critical";
      fail = true;
      summary = `${pausedPrefix}pausing is role-gated, and ${eoaPausers.length} PAUSER_ROLE holder(s) are EOAs (${eoaPausers
        .map((p) => p.address)
        .join(", ")}) — a single key can freeze all transfers.`;
    } else if (pausers && pausers.length) {
      risk = "elevated";
      summary = `${pausedPrefix}pausing is role-gated; ${pausers.length} PAUSER_ROLE holder(s), all contracts — verify each is a timelock/multisig.`;
    } else if (pausers && pausers.length === 0) {
      risk = "info";
      summary = `${pausedPrefix}pausing is role-gated and no address currently holds PAUSER_ROLE (an admin could grant it).`;
    } else {
      risk = "elevated";
      summary = `${pausedPrefix}pausing is role-gated (AccessControl); PAUSER_ROLE holders couldn't be enumerated — verify against an indexer.`;
    }
  } else if (guardianKind === "eoa") {
    risk = "critical";
    fail = true;
    summary = `${pausedPrefix}owner() is a single EOA (${guardian}); if it gates pausing, one key can freeze all transfers.`;
  } else if (guardianKind === "contract") {
    risk = "elevated";
    summary = `${pausedPrefix}pause authority is a contract (owner ${guardian}) — likely a multisig/timelock; inspect it.`;
  } else if (guardianKind === "renounced") {
    risk = "info";
    summary = `${pausedPrefix}ownership renounced — if pausing is owner-gated, it can no longer be triggered; confirm no other pauser path.`;
  } else {
    risk = "elevated";
    summary = `${pausedPrefix}token is pausable but the pause authority couldn't be determined — verify from source.`;
  }

  return { surface, paused, guardianKind, guardian, pausers, pauser, risk, fail, summary };
}
