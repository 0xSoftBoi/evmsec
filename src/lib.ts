import {
  JsonRpcProvider,
  FetchRequest,
  Block,
  Contract,
  Interface,
  getAddress,
  isAddress,
  dataSlice,
  keccak256,
  toUtf8Bytes,
} from "ethers";
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

// ── RPC resilience ──────────────────────────────────────────────────────────
// Public RPCs are flaky: a single transient blip (timeout, 429, 5xx, reset)
// should not abort a CI solvency check. We give every provider a request
// timeout and wrap reads in a bounded exponential-backoff retry.

/** Per-request RPC timeout in ms (override via EVMSEC_RPC_TIMEOUT_MS). */
export const RPC_TIMEOUT_MS = Number(process.env.EVMSEC_RPC_TIMEOUT_MS) || 20_000;
/** How many times to retry a transient RPC failure (override via EVMSEC_RPC_RETRIES). */
export const RPC_RETRIES = Number(process.env.EVMSEC_RPC_RETRIES) || 3;

/**
 * OpenZeppelin AccessControl role identifiers. `DEFAULT_ADMIN_ROLE` is 0x00 by
 * convention; the named roles are keccak256 of their label (re-derived in tests).
 */
export const ROLES = {
  DEFAULT_ADMIN: `0x${"0".repeat(64)}`,
  MINTER: keccak256(toUtf8Bytes("MINTER_ROLE")),
  PAUSER: keccak256(toUtf8Bytes("PAUSER_ROLE")),
} as const;

/** AccessControl reads we need to enumerate role holders. */
export const ACCESS_CONTROL_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
];

const providers = new Map<string, JsonRpcProvider>();

/** One cached provider per chain, reused within a command run. */
export function getProvider(chain: ChainConfig): JsonRpcProvider {
  let p = providers.get(chain.key);
  if (!p) {
    const req = new FetchRequest(chain.rpcUrl);
    req.timeout = RPC_TIMEOUT_MS;
    p = new JsonRpcProvider(req, chain.chainId, { staticNetwork: true });
    providers.set(chain.key, p);
  }
  return p;
}

const TRANSIENT_RPC =
  /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed|rate.?limit|429|too many requests|throttl|502|503|504|bad gateway|service unavailable|SERVER_ERROR|TIMEOUT/i;

/** Heuristic: is this error a transient RPC condition worth retrying? */
export function isTransientRpcError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as { message?: unknown; code?: unknown; shortMessage?: unknown; info?: unknown };
  const parts = [e.message, e.code, e.shortMessage, e.info && JSON.stringify(e.info), String(err)];
  return parts.some((p) => p != null && TRANSIENT_RPC.test(String(p)));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run an async RPC read with bounded exponential-backoff retry on transient
 * failures. Non-transient errors (revert, bad input) throw immediately — a
 * security tool must not paper over a real failure as if it were a blip.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? RPC_RETRIES;
  const base = opts.baseDelayMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTransientRpcError(err)) throw err;
      await sleep(base * 2 ** attempt);
    }
  }
  throw lastErr; // unreachable; satisfies the type checker
}

/**
 * Map over items with bounded concurrency, preserving input order. Lets
 * `solvency --all` check many routes in parallel instead of strictly serially,
 * without opening an unbounded number of RPC connections at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

export function requireAddress(input: string, label = "address"): string {
  if (!isAddress(input)) throw new Error(`invalid ${label}: ${input}`);
  return getAddress(input);
}

export type AddressKind = "eoa" | "contract";

/** Is `address` an EOA (no code) or a contract? Used to spot single-key control. */
export async function addressKind(provider: JsonRpcProvider, address: string): Promise<AddressKind> {
  const code = await withRetry(() => provider.getCode(address), { label: `getCode ${address}` });
  return code === "0x" ? "eoa" : "contract";
}

export interface RoleHolders {
  holders: string[];
  /** how the holders were found — enumerable (reliable), events (best-effort), or none. */
  method: "enumerable" | "events" | "none";
  note?: string;
}

/**
 * Enumerate the current holders of an AccessControl `role`. Prefers
 * AccessControlEnumerable (`getRoleMember*`, exact); falls back to scanning
 * `RoleGranted` events and re-checking `hasRole` (best-effort — public nodes
 * often cap `getLogs` ranges, so a failure is reported honestly, not hidden).
 */
export async function enumerateRoleHolders(
  provider: JsonRpcProvider,
  address: string,
  role: string,
): Promise<RoleHolders> {
  const c = new Contract(address, ACCESS_CONTROL_ABI, provider);

  // 1) AccessControlEnumerable — the exact, paginated path.
  try {
    const count = Number(await withRetry(() => c.getRoleMemberCount(role), { label: "getRoleMemberCount" }));
    if (Number.isFinite(count)) {
      const holders: string[] = [];
      for (let i = 0; i < count; i++) {
        holders.push(getAddress(String(await withRetry(() => c.getRoleMember(role, i), { label: "getRoleMember" }))));
      }
      return { holders, method: "enumerable" };
    }
  } catch {
    // not AccessControlEnumerable — fall through to events
  }

  // 2) RoleGranted events + current hasRole. Best-effort over full history.
  try {
    const logs = await withRetry(() => c.queryFilter(c.filters.RoleGranted(role), 0, "latest"), {
      label: "RoleGranted logs",
    });
    const seen = new Set<string>();
    for (const l of logs) {
      const account = (l as unknown as { args?: { account?: string } }).args?.account;
      if (account) seen.add(getAddress(account));
    }
    const holders: string[] = [];
    for (const a of seen) {
      if (await withRetry(() => c.hasRole(role, a), { label: "hasRole" })) holders.push(a);
    }
    return {
      holders,
      method: "events",
      note: "from RoleGranted history — may be incomplete if the RPC caps getLogs ranges",
    };
  } catch (err) {
    return {
      holders: [],
      method: "none",
      note: `could not enumerate role holders (${err instanceof Error ? err.message : String(err)}) — try an archive/indexer RPC`,
    };
  }
}

/** Read a storage slot and interpret its low 20 bytes as an address (zero -> null). */
export function addressFromSlot(word: string): string | null {
  const addr = getAddress(dataSlice(word, 12, 32));
  return addr === "0x0000000000000000000000000000000000000000" ? null : addr;
}

/**
 * Which of a set of 4-byte function selectors appear in a contract's dispatcher.
 * Walks the bytecode, correctly skipping PUSH immediates so data bytes aren't
 * mistaken for opcodes, and collects any PUSH4 selector present in `wanted`.
 */
export function selectorsPresent(bytecode: string, wanted: Set<string>): Set<string> {
  const PUSH1 = 0x60;
  const PUSH4 = 0x63;
  const PUSH32 = 0x7f;
  const found = new Set<string>();
  if (!bytecode || bytecode === "0x") return found;
  const hex = bytecode.toLowerCase().replace(/^0x/, "");
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === PUSH4) {
      let sel = "";
      for (let j = 1; j <= 4 && i + j < bytes.length; j++) sel += bytes[i + j].toString(16).padStart(2, "0");
      if (sel.length === 8 && wanted.has(sel)) found.add(sel);
      i += 4;
    } else if (op >= PUSH1 && op <= PUSH32) {
      i += op - PUSH1 + 1;
    }
  }
  return found;
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
    const fetched = await withRetry(() => provider.getBlock(n), { label: `getBlock ${chainKey}:${n}` });
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
  const latest = await withRetry(() => provider.getBlockNumber(), { label: `getBlockNumber ${chainKey}` });
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
