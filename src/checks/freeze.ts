import { Contract } from "ethers";
import { Check, CheckContext, CheckReport, Severity, report } from "../check.js";
import { addressKind, requireAddress, withRetry } from "../lib.js";
import { RoleHolder } from "../mint-authority-core.js";
import { classifyFreezeAuthority, classifyFreezeSurface } from "../freeze-core.js";
import { resolveImplementation } from "./onchain.js";

const BLACKLISTER_ABI = ["function blacklister() view returns (address)"];
const OWNER_ABI = ["function owner() view returns (address)"];

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
    let authority: RoleHolder | null = null;
    if (surface.canFreeze) {
      const abi = surface.hasBlacklisterGetter ? BLACKLISTER_ABI : OWNER_ABI;
      const fn = surface.hasBlacklisterGetter ? "blacklister" : "owner";
      try {
        const raw = (await withRetry(() => new Contract(target, abi, provider)[fn](), { label: `${fn}()` })) as string;
        const addr = requireAddress(raw, fn);
        authority = { address: addr, kind: /^0x0+$/i.test(addr) ? "renounced" : await addressKind(provider, addr) };
      } catch {
        authority = null;
      }
    }

    const verdict = classifyFreezeAuthority(surface, authority);

    const evidence: CheckReport["evidence"] = {
      "can freeze holders": surface.canFreeze,
      pattern: surface.pattern,
      "can seize balance": surface.canSeize,
    };
    if (implementation) evidence.implementation = implementation;
    if (authority) evidence["freeze authority"] = authority.address;

    const severity: Severity = verdict.fail ? "critical" : verdict.risk === "elevated" ? "warning" : "ok";
    return report({
      id: this.id,
      title: this.title,
      severity,
      summary: verdict.summary,
      evidence,
      notes: surface.indicators,
    });
  },
};
