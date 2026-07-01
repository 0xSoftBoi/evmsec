import { Check, CheckContext, CheckReport, report, verdictToSeverity } from "../check.js";
import { withRetry } from "../lib.js";
import { RoleHolder } from "../mint-authority-core.js";
import { classifyFreezeAuthority, classifyFreezeSurface } from "../freeze-core.js";
import { resolveImplementation, resolveRoleHolder } from "./onchain.js";

/**
 * Can an *individual* holder be frozen (or their balance seized), and who holds
 * that power? The targeted-censorship sibling of `pause-guardian`: FiatToken
 * (USDC-class) has a `blacklister` role; Tether (USDT) has an owner-gated
 * `addBlackList` plus `destroyBlackFunds` (burns a frozen balance).
 */
export const freezeAuthorityCheck: Check = {
  id: "freeze-authority",
  title: "Freeze authority",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const { provider, target, code } = ctx;
    const implementation = await resolveImplementation(provider, target);
    const scanned = implementation
      ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
      : code;
    const surface = classifyFreezeSurface(scanned);

    // Resolve the freeze authority: FiatToken -> blacklister(); Tether -> owner().
    const authority: RoleHolder | null = surface.canFreeze
      ? await resolveRoleHolder(provider, target, surface.hasBlacklisterGetter ? "blacklister" : "owner")
      : null;

    const verdict = classifyFreezeAuthority(surface, authority);

    const evidence: CheckReport["evidence"] = {
      "can freeze holders": surface.canFreeze,
      pattern: surface.pattern,
      "can seize balance": surface.canSeize,
    };
    if (implementation) evidence.implementation = implementation;
    if (authority) evidence["freeze authority"] = authority.address;

    return report({
      id: this.id,
      title: this.title,
      severity: verdictToSeverity(verdict),
      summary: verdict.summary,
      evidence,
      notes: surface.indicators,
    });
  },
};
