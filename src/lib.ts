import { JsonRpcProvider, Interface, getAddress, isAddress, dataSlice, keccak256, toUtf8Bytes } from "ethers";
import { ChainConfig } from "./config.js";

/** Minimal ERC-20 ABI for the reads this toolkit needs. */
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
];

export const erc20Interface = new Interface(ERC20_ABI);

/** EIP-1967 storage slots (used by transparent + UUPS proxies). */
export const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;

/**
 * Legacy OpenZeppelin/zeppelinos proxy slots — plain keccak256 of the label
 * (no EIP-1967 `- 1`). Still live under major contracts, notably USDC's
 * FiatTokenProxy. Computed at runtime so the hash can't be mistyped.
 */
export const ZEPPELINOS = {
  implementation: keccak256(toUtf8Bytes("org.zeppelinos.proxy.implementation")),
  admin: keccak256(toUtf8Bytes("org.zeppelinos.proxy.admin")),
} as const;

const providers = new Map<string, JsonRpcProvider>();

/** One cached provider per chain, reused within a command run. */
export function getProvider(chain: ChainConfig): JsonRpcProvider {
  let p = providers.get(chain.key);
  if (!p) {
    p = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    providers.set(chain.key, p);
  }
  return p;
}

export function requireAddress(input: string, label = "address"): string {
  if (!isAddress(input)) throw new Error(`invalid ${label}: ${input}`);
  return getAddress(input);
}

/** Read a storage slot and interpret its low 20 bytes as an address (zero -> null). */
export function addressFromSlot(word: string): string | null {
  const addr = getAddress(dataSlice(word, 12, 32));
  return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
}

/** Scale a raw integer with `decimals` up/down to a common 18-decimal fixed point. */
export function to18(raw: bigint, decimals: number): bigint {
  if (decimals === 18) return raw;
  return decimals < 18
    ? raw * 10n ** BigInt(18 - decimals)
    : raw / 10n ** BigInt(decimals - 18);
}

export function addrLink(chain: ChainConfig, address: string): string {
  return `${chain.explorer}/address/${address}`;
}

export function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
