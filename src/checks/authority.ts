import { Check, CheckContext, CheckReport, Severity, report } from "../check.js";
import { addressKind } from "../lib.js";
import { classifyAuthority } from "../authority-core.js";
import { probeSafe, probeTimelock, resolveAuthority } from "./onchain.js";

/**
 * Not just *who* controls a contract, but *what kind* of authority it is — the
 * factor that sets the blast radius. A 1-of-N "multisig" is one key; a timelock
 * with a zero delay gives no window to react to a malicious upgrade.
 */
export const authorityCheck: Check = {
  id: "admin-power",
  title: "Admin power",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const { provider, target, opts } = ctx;
    const authority = await resolveAuthority(provider, target);

    let isZero = false;
    let isEoa: boolean | undefined;
    let safe: Awaited<ReturnType<typeof probeSafe>> = null;
    let delaySec: number | null = null;
    if (authority !== null) {
      isZero = /^0x0+$/i.test(authority);
      if (!isZero) {
        isEoa = (await addressKind(provider, authority)) === "eoa";
        if (!isEoa) {
          safe = await probeSafe(provider, authority);
          if (!safe) delaySec = await probeTimelock(provider, authority);
        }
      }
    }

    const verdict = classifyAuthority({
      address: authority,
      isZero,
      isEoa,
      safe,
      timelock: delaySec !== null ? { delaySec } : undefined,
      minDelaySec: opts.minDelaySec,
    });

    const evidence: CheckReport["evidence"] = { authority: authority ?? null, kind: verdict.kind };
    if (safe) evidence.multisig = `${safe.threshold}-of-${safe.owners}`;
    if (delaySec !== null) evidence["timelock delay"] = `${delaySec}s`;

    // "unknown" means we could not resolve a controller (no EIP-1967 admin, no
    // owner()) — that's a review item, not a clean pass: a contract may still be
    // controlled through a non-standard admin (Compound-style `admin()`) or
    // AccessControl roles that this check doesn't resolve. Renounced (zero) stays ok.
    const severity: Severity = verdict.fail
      ? "critical"
      : verdict.risk === "elevated" || verdict.kind === "unknown"
        ? "warning"
        : "ok";

    const notes = ["confirm the full privileged-role set against source — this resolves one controlling authority."];
    if (verdict.kind === "unknown")
      notes.push("no EIP-1967 admin or owner() found — control may live in a custom scheme; inspect directly.");

    return report({ id: this.id, title: this.title, severity, summary: verdict.summary, evidence, notes });
  },
};
