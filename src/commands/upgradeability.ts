import { chain } from "../config.js";
import { EIP1967, ZEPPELINOS, addrLink, addressFromSlot, getProvider, requireAddress, shortAddr } from "../lib.js";

/**
 * `evmsec upgradeability <address> [--chain ethereum]`
 *
 * Reads EIP-1967 proxy slots to answer: is this contract upgradeable, and who
 * controls the upgrade? An upgradeable token/bridge controlled by an EOA is a
 * single key away from a rug — exactly the trust assumption an auditor wants
 * surfaced before reasoning about anything else.
 */
export async function upgradeability(args: string[]): Promise<void> {
  const { address, chainKey } = parse(args);
  if (!address) throw new Error("usage: evmsec upgradeability <address> [--chain ethereum]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  const code = await provider.getCode(target);
  if (code === "0x") {
    console.log(`\n${target} on ${c.name} has no code (EOA or undeployed).\n`);
    return;
  }

  const [implWord, adminWord, beaconWord, legacyImplWord, legacyAdminWord] = await Promise.all([
    provider.getStorage(target, EIP1967.implementation),
    provider.getStorage(target, EIP1967.admin),
    provider.getStorage(target, EIP1967.beacon),
    provider.getStorage(target, ZEPPELINOS.implementation),
    provider.getStorage(target, ZEPPELINOS.admin),
  ]);

  // Prefer EIP-1967; fall back to the legacy zeppelinos slot (e.g. USDC).
  const legacyImpl = addressFromSlot(legacyImplWord);
  const impl = addressFromSlot(implWord) ?? legacyImpl;
  const admin = addressFromSlot(adminWord) ?? addressFromSlot(legacyAdminWord);
  const beacon = addressFromSlot(beaconWord);
  const isLegacy = !addressFromSlot(implWord) && legacyImpl !== null;

  console.log(`\nUpgradeability — ${target} on ${c.name}`);
  console.log("─".repeat(64));

  if (!impl && !beacon) {
    console.log("  No EIP-1967 or legacy zeppelinos implementation/beacon slot set.");
    console.log("  → Not a standard proxy (could still be a custom proxy —");
    console.log("    verify the source if upgradeability matters).\n");
    return;
  }

  const pattern = beacon
    ? "beacon proxy"
    : isLegacy
      ? "legacy zeppelinos proxy (pre-EIP-1967)"
      : "transparent / UUPS proxy";
  console.log(`  pattern         ${pattern}`);
  if (impl) console.log(`  implementation  ${impl}\n                  ${addrLink(c, impl)}`);
  if (beacon) console.log(`  beacon          ${beacon}\n                  ${addrLink(c, beacon)}`);

  if (admin) {
    const adminCode = await provider.getCode(admin);
    const kind = adminCode === "0x" ? "EOA (single key)" : "contract (multisig / timelock / ProxyAdmin — inspect it)";
    console.log(`  upgrade admin   ${admin}  → ${kind}`);
    console.log(`                  ${addrLink(c, admin)}`);
    if (adminCode === "0x") {
      console.log(`  ⚠ risk          upgrades are controlled by a single EOA (${shortAddr(admin)});`);
      console.log(`                  one compromised key can replace the implementation.`);
    }
  } else {
    console.log(`  upgrade admin   not in EIP-1967 admin slot`);
    console.log(`                  → likely UUPS: upgrade auth lives in the implementation`);
    console.log(`                    (check its owner/role gating).`);
  }
  console.log();
}

function parse(args: string[]): { address?: string; chainKey: string } {
  let address: string | undefined;
  let chainKey = "ethereum";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") chainKey = args[++i];
    else if (!address) address = args[i];
  }
  return { address, chainKey };
}
