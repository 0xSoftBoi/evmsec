import { Contract } from "ethers";
import { Check, CheckContext, CheckReport, report, verdictToSeverity } from "../check.js";
import { ROLES, addressKind, enumerateRoleHolders, withRetry } from "../lib.js";
import { OwnerKind, RoleHolder } from "../mint-authority-core.js";
import { classifyPauseGuardian, classifyPauseSurface } from "../pause-guardian-core.js";
import { resolveImplementation, resolveRoleHolder } from "./onchain.js";

const PAUSED_ABI = ["function paused() view returns (bool)"];

/**
 * Can transfers be frozen, are they frozen right now, and who holds the pause
 * key? A single EOA that can pause a wrapped asset can halt every holder at once
 * — a liveness / censorship vector.
 */
export const pauseGuardianCheck: Check = {
  id: "pause-guardian",
  title: "Pause guardian",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const { provider, target, code } = ctx;
    const implementation = await resolveImplementation(provider, target);
    const scanned = implementation
      ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
      : code;
    const surface = classifyPauseSurface(scanned);

    let paused: boolean | null = null;
    if (surface.hasPausedView || surface.pausable) {
      try {
        paused = Boolean(
          await withRetry(() => new Contract(target, PAUSED_ABI, provider).paused(), { label: "paused()" }),
        );
      } catch {
        paused = null;
      }
    }

    let guardian: string | null = null;
    let guardianKind: OwnerKind = "unknown";
    let pausers: RoleHolder[] | undefined;
    let pauserNote: string | undefined;
    let pauser: RoleHolder | null = null;

    if (surface.hasPauserGetter) {
      // FiatToken (USDC-class): pausing is gated by pauser(), not owner().
      pauser = await resolveRoleHolder(provider, target, "pauser");
    } else if (surface.authModel === "access-control" || surface.authModel === "ownable+access-control") {
      const found = await enumerateRoleHolders(provider, target, ROLES.PAUSER);
      pauserNote = found.note;
      if (found.method !== "none") {
        pausers = [];
        for (const a of found.holders) pausers.push({ address: a, kind: await addressKind(provider, a) });
      }
    } else if (surface.authModel === "ownable") {
      const rh = await resolveRoleHolder(provider, target, "owner");
      if (rh) {
        guardian = rh.address;
        guardianKind = rh.kind;
      }
    }

    const verdict = classifyPauseGuardian(surface, paused, guardianKind, guardian, pausers, pauser);

    const evidence: CheckReport["evidence"] = {
      pausable: surface.pausable,
      "paused now": paused === null ? "unknown" : paused,
      "auth model": surface.hasPauserGetter ? "FiatToken pauser()" : surface.authModel,
    };
    if (implementation) evidence.implementation = implementation;
    if (pauser) evidence.pauser = pauser.address;
    if (guardian) evidence.guardian = guardian;

    const notes: string[] = [];
    if (pausers) {
      if (pausers.length === 0) notes.push("PAUSER_ROLE: no current holders");
      else for (const p of pausers) notes.push(`PAUSER_ROLE: ${p.address} (${p.kind})`);
    } else if (pauserNote) {
      notes.push(`PAUSER_ROLE not enumerated — ${pauserNote}`);
    }

    return report({
      id: this.id,
      title: this.title,
      severity: verdictToSeverity(verdict),
      summary: verdict.summary,
      evidence,
      notes,
    });
  },
};
