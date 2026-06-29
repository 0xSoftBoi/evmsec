/**
 * Shared on-chain reads used by more than one check. Kept thin and retry-wrapped;
 * the verdict logic lives in the pure `*-core.ts` modules, not here.
 */

import { Contract, getAddress } from "ethers";
import { Provider } from "../check.js";
import { EIP1967, ZEPPELINOS, addressFromSlot, withRetry } from "../lib.js";

/** Follow EIP-1967 / legacy zeppelinos implementation slots; null if not a proxy. */
export async function resolveImplementation(provider: Provider, target: string): Promise<string | null> {
  const [implWord, legacyWord] = await Promise.all([
    withRetry(() => provider.getStorage(target, EIP1967.implementation), { label: "impl slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.implementation), { label: "legacy impl slot" }),
  ]);
  return addressFromSlot(implWord) ?? addressFromSlot(legacyWord);
}

/** The controlling authority: EIP-1967 (or legacy) admin slot, else `owner()`. */
export async function resolveAuthority(provider: Provider, target: string): Promise<string | null> {
  const [adminWord, legacyAdminWord] = await Promise.all([
    withRetry(() => provider.getStorage(target, EIP1967.admin), { label: "admin slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.admin), { label: "legacy admin slot" }),
  ]);
  const admin = addressFromSlot(adminWord) ?? addressFromSlot(legacyAdminWord);
  if (admin) return admin;

  try {
    const raw = await withRetry(
      () => new Contract(target, ["function owner() view returns (address)"], provider).owner(),
      { label: "owner()" },
    );
    return getAddress(String(raw));
  } catch {
    return null;
  }
}

export interface SafeInfo {
  threshold: number;
  owners: number;
}

/** Read a Gnosis Safe's threshold/owner-count, or null if the address isn't a Safe. */
export async function probeSafe(provider: Provider, addr: string): Promise<SafeInfo | null> {
  try {
    const safe = new Contract(
      addr,
      ["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"],
      provider,
    );
    const [threshold, owners] = await Promise.all([
      withRetry(() => safe.getThreshold(), { label: "getThreshold" }),
      withRetry(() => safe.getOwners(), { label: "getOwners" }),
    ]);
    return { threshold: Number(threshold), owners: (owners as string[]).length };
  } catch {
    return null;
  }
}

/** Read a timelock's configured min delay (OZ `getMinDelay` or Compound `delay`), in seconds. */
export async function probeTimelock(provider: Provider, addr: string): Promise<number | null> {
  for (const fn of ["getMinDelay", "delay"] as const) {
    try {
      const d = await withRetry(() => new Contract(addr, [`function ${fn}() view returns (uint256)`], provider)[fn](), {
        label: fn,
      });
      return Number(d);
    } catch {
      // try the next variant
    }
  }
  return null;
}

/** Best-effort read of a supply cap (`cap()` / `maxSupply()`) as a string, or null. */
export async function readCap(provider: Provider, target: string): Promise<string | null> {
  const token = new Contract(
    target,
    ["function cap() view returns (uint256)", "function maxSupply() view returns (uint256)"],
    provider,
  );
  for (const fn of ["cap", "maxSupply"] as const) {
    try {
      return String((await withRetry(() => token[fn](), { label: fn })) as bigint);
    } catch {
      // try the next getter
    }
  }
  return null;
}
