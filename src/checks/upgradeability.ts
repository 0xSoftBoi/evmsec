import { Check, CheckContext, CheckReport, report } from "../check.js";
import { EIP1967, ZEPPELINOS, addressFromSlot, shortAddr, withRetry } from "../lib.js";

/**
 * Is this contract an upgradeable proxy, and who controls the upgrade? An
 * upgradeable token/bridge whose admin is a single EOA is one key away from a
 * rug — the trust assumption to surface before reasoning about anything else.
 */
export const upgradeabilityCheck: Check = {
  id: "upgradeability",
  title: "Upgradeability",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const { provider, target } = ctx;
    const [implWord, adminWord, beaconWord, legacyImplWord, legacyAdminWord] = await Promise.all([
      withRetry(() => provider.getStorage(target, EIP1967.implementation), { label: "impl slot" }),
      withRetry(() => provider.getStorage(target, EIP1967.admin), { label: "admin slot" }),
      withRetry(() => provider.getStorage(target, EIP1967.beacon), { label: "beacon slot" }),
      withRetry(() => provider.getStorage(target, ZEPPELINOS.implementation), { label: "legacy impl slot" }),
      withRetry(() => provider.getStorage(target, ZEPPELINOS.admin), { label: "legacy admin slot" }),
    ]);

    const legacyImpl = addressFromSlot(legacyImplWord);
    const impl = addressFromSlot(implWord) ?? legacyImpl;
    const admin = addressFromSlot(adminWord) ?? addressFromSlot(legacyAdminWord);
    const beacon = addressFromSlot(beaconWord);
    const isLegacy = !addressFromSlot(implWord) && legacyImpl !== null;

    if (!impl && !beacon) {
      return report({
        id: this.id,
        title: this.title,
        severity: "ok",
        summary:
          "no EIP-1967 or legacy implementation/beacon slot set — not a standard proxy (could still be a custom proxy; verify from source if upgradeability matters).",
      });
    }

    const pattern = beacon ? "beacon proxy" : isLegacy ? "legacy zeppelinos proxy" : "transparent / UUPS proxy";
    const evidence: CheckReport["evidence"] = { pattern, implementation: impl ?? null };
    if (beacon) evidence.beacon = beacon;

    if (!admin) {
      return report({
        id: this.id,
        title: this.title,
        severity: "warning",
        summary:
          "upgradeable proxy with no admin in the EIP-1967 admin slot — likely UUPS: upgrade authority lives in the implementation. Confirm its owner/role gating (run admin-power on the implementation).",
        evidence,
      });
    }

    const adminCode = await withRetry(() => provider.getCode(admin), { label: "admin getCode" });
    const adminIsEoa = adminCode === "0x";
    evidence["upgrade admin"] = admin;
    evidence["admin kind"] = adminIsEoa ? "EOA (single key)" : "contract";

    if (adminIsEoa) {
      return report({
        id: this.id,
        title: this.title,
        severity: "critical",
        summary: `upgrades are controlled by a single EOA (${shortAddr(admin)}) — one compromised key can replace the implementation and drain or brick the contract.`,
        evidence,
      });
    }

    return report({
      id: this.id,
      title: this.title,
      severity: "ok",
      summary:
        "upgradeable, but the upgrade admin is a contract (multisig / timelock / ProxyAdmin) — not a single key. Run admin-power to classify it.",
      evidence,
    });
  },
};
