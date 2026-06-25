import { ChainConfig, chain } from "../config.js";
import {
  EIP1967,
  ZEPPELINOS,
  addrLink,
  addressFromSlot,
  getProvider,
  requireAddress,
  shortAddr,
  withRetry,
} from "../lib.js";

interface UpgradeabilityResult {
  address: string;
  chain: string;
  isProxy: boolean;
  pattern: string | null;
  implementation: string | null;
  beacon: string | null;
  admin: string | null;
  adminKind: "eoa" | "contract" | null;
  /** true when upgrades are controlled by a single EOA — a one-key rug vector. */
  singleKeyRisk: boolean;
  notes: string[];
}

/**
 * `evmsec upgradeability <address> [--chain ethereum] [--json]`
 *
 * Reads EIP-1967 proxy slots to answer: is this contract upgradeable, and who
 * controls the upgrade? An upgradeable token/bridge controlled by an EOA is a
 * single key away from a rug — exactly the trust assumption an auditor wants
 * surfaced before reasoning about anything else.
 */
export async function upgradeability(args: string[]): Promise<void> {
  const { address, chainKey, json } = parse(args);
  if (!address) throw new Error("usage: evmsec upgradeability <address> [--chain ethereum] [--json]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  if (code === "0x") {
    const result: UpgradeabilityResult = {
      address: target,
      chain: c.key,
      isProxy: false,
      pattern: null,
      implementation: null,
      beacon: null,
      admin: null,
      adminKind: null,
      singleKeyRisk: false,
      notes: ["no code (EOA or undeployed)"],
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`\n${target} on ${c.name} has no code (EOA or undeployed).\n`);
    return;
  }

  const [implWord, adminWord, beaconWord, legacyImplWord, legacyAdminWord] = await Promise.all([
    withRetry(() => provider.getStorage(target, EIP1967.implementation), { label: "impl slot" }),
    withRetry(() => provider.getStorage(target, EIP1967.admin), { label: "admin slot" }),
    withRetry(() => provider.getStorage(target, EIP1967.beacon), { label: "beacon slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.implementation), { label: "legacy impl slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.admin), { label: "legacy admin slot" }),
  ]);

  // Prefer EIP-1967; fall back to the legacy zeppelinos slot (e.g. USDC).
  const legacyImpl = addressFromSlot(legacyImplWord);
  const impl = addressFromSlot(implWord) ?? legacyImpl;
  const admin = addressFromSlot(adminWord) ?? addressFromSlot(legacyAdminWord);
  const beacon = addressFromSlot(beaconWord);
  const isLegacy = !addressFromSlot(implWord) && legacyImpl !== null;

  const result: UpgradeabilityResult = {
    address: target,
    chain: c.key,
    isProxy: Boolean(impl || beacon),
    pattern: null,
    implementation: impl,
    beacon,
    admin,
    adminKind: null,
    singleKeyRisk: false,
    notes: [],
  };

  if (!impl && !beacon) {
    result.notes.push("no EIP-1967 or legacy zeppelinos implementation/beacon slot set — not a standard proxy");
  } else {
    result.pattern = beacon
      ? "beacon proxy"
      : isLegacy
        ? "legacy zeppelinos proxy (pre-EIP-1967)"
        : "transparent / UUPS proxy";
    if (admin) {
      const adminCode = await withRetry(() => provider.getCode(admin), { label: "admin getCode" });
      result.adminKind = adminCode === "0x" ? "eoa" : "contract";
      result.singleKeyRisk = adminCode === "0x";
      if (result.singleKeyRisk) {
        result.notes.push(
          `upgrades are controlled by a single EOA (${shortAddr(admin)}) — one compromised key can replace the implementation`,
        );
      }
    } else {
      result.notes.push(
        "no admin in the EIP-1967 admin slot — likely UUPS: upgrade auth lives in the implementation (check its owner/role gating)",
      );
    }
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else print(c, result);
}

function print(c: ChainConfig, r: UpgradeabilityResult): void {
  console.log(`\nUpgradeability — ${r.address} on ${c.name}`);
  console.log("─".repeat(64));

  if (!r.isProxy) {
    console.log("  No EIP-1967 or legacy zeppelinos implementation/beacon slot set.");
    console.log("  → Not a standard proxy (could still be a custom proxy —");
    console.log("    verify the source if upgradeability matters).\n");
    return;
  }

  console.log(`  pattern         ${r.pattern}`);
  if (r.implementation)
    console.log(`  implementation  ${r.implementation}\n                  ${addrLink(c, r.implementation)}`);
  if (r.beacon) console.log(`  beacon          ${r.beacon}\n                  ${addrLink(c, r.beacon)}`);

  if (r.admin) {
    const kind =
      r.adminKind === "eoa" ? "EOA (single key)" : "contract (multisig / timelock / ProxyAdmin — inspect it)";
    console.log(`  upgrade admin   ${r.admin}  → ${kind}`);
    console.log(`                  ${addrLink(c, r.admin)}`);
    if (r.singleKeyRisk) {
      console.log(`  ⚠ risk          upgrades are controlled by a single EOA (${shortAddr(r.admin)});`);
      console.log(`                  one compromised key can replace the implementation.`);
    }
  } else {
    console.log(`  upgrade admin   not in EIP-1967 admin slot`);
    console.log(`                  → likely UUPS: upgrade auth lives in the implementation`);
    console.log(`                    (check its owner/role gating).`);
  }
  console.log();
}

function parse(args: string[]): { address?: string; chainKey: string; json: boolean } {
  let address: string | undefined;
  let chainKey = "ethereum";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error("--chain requires a value (e.g. --chain ethereum)");
      chainKey = args[++i];
    } else if (args[i] === "--json") json = true;
    else if (!address) address = args[i];
  }
  return { address, chainKey, json };
}
