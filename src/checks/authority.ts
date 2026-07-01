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

    // "unknown" = we could not resolve a controller via the two patterns this
    // check understands (EIP-1967 admin slot, `owner()`). We fail *closed* — a
    // security tool shouldn't show a green pass for "I couldn't tell who controls
    // this" — but this is explicitly NOT an accusation: the target may be
    // immutable, renounced elsewhere, or governed by a DAO / AccessControl roles /
    // a Compound-style `admin()` that this check does not resolve. Expect it on
    // many well-run contracts (Curve, Frax, Balancer all land here). Renounced
    // (zero address) is a clean ok.
    const severity: Severity = verdict.fail
      ? "critical"
      : verdict.risk === "elevated" || verdict.kind === "unknown"
        ? "warning"
        : "ok";

    const notes = [
      "confirm the full privileged-role set against source — this resolves at most one controlling authority.",
    ];
    if (verdict.kind === "unknown")
      notes.push(
        "NOT ASSESSED — no EIP-1967 admin or owner() found. Could be immutable/renounced, or DAO/AccessControl/custom governance this check doesn't resolve. Inspect manually; don't read this as a confirmed risk.",
      );

    return report({ id: this.id, title: this.title, severity, summary: verdict.summary, evidence, notes });
  },
};
