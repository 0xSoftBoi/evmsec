import { JsonRpcProvider, Block, Interface, getAddress, isAddress, dataSlice, keccak256, toUtf8Bytes } from "ethers";
import { ChainConfig } from "./config.js";

/** Minimal ERC-20 ABI for the reads this toolkit needs. */
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export const erc20Interface = new Interface(ERC20_ABI);

/**
 * ERC-7683 `Open` event — emitted by the origin settler when an intent is
 * created. Carries the full ResolvedCrossChainOrder, including `maxSpent`
 * (the outputs the filler must deliver to the user on the destination chain).
 */
export const ERC7683_ABI = [
  "event Open(bytes32 indexed orderId, tuple(address user, uint256 originChainId, uint32 openDeadline, uint32 fillDeadline, bytes32 orderId, tuple(bytes32 token, uint256 amount, bytes32 recipient, uint256 chainId)[] maxSpent, tuple(bytes32 token, uint256 amount, bytes32 recipient, uint256 chainId)[] minReceived, tuple(uint64 destinationChainId, bytes32 destinationSettler, bytes originData)[] fillInstructions) resolvedOrder)",
];

export const erc7683Interface = new Interface(ERC7683_ABI);

/** ERC-7683 uses bytes32 for tokens/recipients (non-EVM support); take low 20 bytes. */
export function bytes32ToAddress(word: string): string {
  return getAddress(dataSlice(word, 12, 32));
}

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
  return decimals < 18 ? raw * 10n ** BigInt(18 - decimals) : raw / 10n ** BigInt(decimals - 18);
}

/** Backing ratio in percent (locked/minted), or null when nothing is minted. */
export function backingPct(locked18: bigint, minted18: bigint): number | null {
  if (minted18 === 0n) return null;
  return Number((locked18 * 1_000_000n) / minted18) / 10_000;
}

/** True when locked/minted < minRatioPct — i.e. undercollateralized vs threshold. */
export function isUnderBacked(locked18: bigint, minted18: bigint, minRatioPct: number): boolean {
  if (minted18 === 0n) return false;
  // locked/minted < minRatioPct%  ⇔  locked*10000 < minted*round(minRatioPct*100)
  return locked18 * 10_000n < minted18 * BigInt(Math.round(minRatioPct * 100));
}

/**
 * Find the first integer in (lo, hi] where `isBreached` flips to true, assuming
 * it is false at lo and true at hi (monotonic transition). Returns the boundary
 * and probe count; converges in ~log2(hi - lo) calls to `isBreached`.
 */
export async function firstBreachBlock(
  lo: number,
  hi: number,
  isBreached: (n: number) => Promise<boolean>,
): Promise<{ lastHealthy: number; firstBroken: number; probes: number }> {
  let probes = 0;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    probes++;
    if (await isBreached(mid)) hi = mid;
    else lo = mid;
  }
  return { lastHealthy: lo, firstBroken: hi, probes };
}

export function addrLink(chain: ChainConfig, address: string): string {
  return `${chain.explorer}/address/${address}`;
}

export function blockLink(chain: ChainConfig, block: number): string {
  return `${chain.explorer}/block/${block}`;
}

export function txLink(chain: ChainConfig, hash: string): string {
  return `${chain.explorer}/tx/${hash}`;
}

export function shortAddr(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const blockCache = new Map<string, Block>();

/** getBlock with a per-(chain,number) cache — bisection revisits the same blocks. */
export async function getBlockCached(provider: JsonRpcProvider, chainKey: string, n: number): Promise<Block> {
  const key = `${chainKey}:${n}`;
  let b = blockCache.get(key);
  if (!b) {
    const fetched = await provider.getBlock(n);
    if (!fetched) throw new Error(`block ${n} not found on ${chainKey}`);
    b = fetched;
    blockCache.set(key, b);
  }
  return b;
}

/**
 * Highest block on `provider` whose timestamp is <= targetTs (binary search).
 * Used to align the source chain to a destination-chain block's wall-clock time
 * when checking a cross-chain invariant historically.
 */
export async function blockAtOrBefore(provider: JsonRpcProvider, chainKey: string, targetTs: number): Promise<number> {
  const latest = await provider.getBlockNumber();
  const head = await getBlockCached(provider, chainKey, latest);
  if (head.timestamp <= targetTs) return latest;

  let lo = 0;
  let hi = latest;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const b = await getBlockCached(provider, chainKey, mid);
    if (b.timestamp <= targetTs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
