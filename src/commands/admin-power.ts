import { Contract, getAddress } from "ethers";
import { ChainConfig, chain } from "../config.js";
import {
  EIP1967,
  ZEPPELINOS,
  addrLink,
  addressFromSlot,
  addressKind,
  getProvider,
  requireAddress,
  withRetry,
} from "../lib.js";
import { AuthorityVerdict, SafeInfo, TimelockInfo, classifyAuthority } from "../authority-core.js";

/**
 * `evmsec admin-power <address> [--chain ethereum] [--min-delay 24] [--json]`
 *
 * Answers "who controls this contract, and how dangerous is that control?" —
 * the centralization question behind most rugs and admin-key incidents. Resolves
 * the controlling authority (EIP-1967 proxy admin, else `owner()`) and
 * classifies it: a single **EOA**, a **Gnosis Safe** (with its threshold), a
 * **timelock** (with its delay), an unrecognized **contract**, or **renounced**.
 *
 * Exit code is non-zero when a single key controls it (an EOA, or a 1-of-N
 * Safe) — so it drops into CI alongside the other checks.
 */
export async function adminPower(args: string[]): Promise<void> {
  const { address, chainKey, minDelaySec, json } = parse(args);
  if (!address) throw new Error("usage: evmsec admin-power <address> [--chain ethereum] [--min-delay 24] [--json]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  if (code === "0x") {
    const msg = `${target} on ${c.name} is an EOA (no code) — there is no contract authority to classify.`;
    if (json) console.log(JSON.stringify({ address: target, chain: c.key, error: "target is an EOA" }, null, 2));
    else console.log(`\n${msg}\n`);
    process.exitCode = 1;
    return;
  }

  const authority = await resolveAuthority(provider, target);

  let isZero = false;
  let isEoa: boolean | undefined;
  let safe: SafeInfo | null | undefined;
  let timelock: TimelockInfo | null | undefined;
  if (authority !== null) {
    isZero = /^0x0+$/i.test(authority);
    if (!isZero) {
      isEoa = (await addressKind(provider, authority)) === "eoa";
      if (!isEoa) {
        safe = await probeSafe(provider, authority);
        if (!safe) timelock = await probeTimelock(provider, authority);
      }
    }
  }

  const verdict = classifyAuthority({ address: authority, isZero, isEoa, safe, timelock, minDelaySec });

  if (json) {
    console.log(
      JSON.stringify(
        {
          address: target,
          chain: c.key,
          authority,
          kind: verdict.kind,
          safe: safe ?? null,
          timelock: timelock ?? null,
          risk: verdict.risk,
          summary: verdict.summary,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, target, authority, safe, timelock, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
}

/** Resolve the controlling authority: EIP-1967 (or legacy) admin slot, else owner(). */
async function resolveAuthority(provider: ReturnType<typeof getProvider>, target: string): Promise<string | null> {
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

async function probeSafe(provider: ReturnType<typeof getProvider>, addr: string): Promise<SafeInfo | null> {
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
    return null; // not a Gnosis Safe
  }
}

async function probeTimelock(provider: ReturnType<typeof getProvider>, addr: string): Promise<TimelockInfo | null> {
  for (const fn of ["getMinDelay", "delay"] as const) {
    try {
      const d = await withRetry(() => new Contract(addr, [`function ${fn}() view returns (uint256)`], provider)[fn](), {
        label: fn,
      });
      return { delaySec: Number(d) };
    } catch {
      // try the next variant
    }
  }
  return null;
}

const RISK_MARK: Record<string, string> = { critical: "✗ CRITICAL", elevated: "⚠ ELEVATED", info: "· INFO" };
const KIND_LABEL: Record<AuthorityVerdict["kind"], string> = {
  renounced: "renounced (zero address)",
  eoa: "EOA (single key)",
  safe: "Gnosis Safe multisig",
  timelock: "timelock",
  contract: "contract (unrecognized — inspect)",
  unknown: "not resolvable",
};

function print(
  c: ChainConfig,
  target: string,
  authority: string | null,
  safe: SafeInfo | null | undefined,
  timelock: TimelockInfo | null | undefined,
  v: AuthorityVerdict,
): void {
  console.log(`\nAdmin-power — ${target} on ${c.name}`);
  console.log("─".repeat(68));
  if (authority) console.log(`  authority       ${authority}\n                  ${addrLink(c, authority)}`);
  console.log(`  kind            ${KIND_LABEL[v.kind]}`);
  if (safe) console.log(`  multisig        ${safe.threshold}-of-${safe.owners}`);
  if (timelock) console.log(`  timelock delay  ${timelock.delaySec} seconds`);
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  console.log(`\n  ${v.summary}`);
  console.log(`\n  Heuristic from on-chain reads — confirm the full privileged-role set against source.\n`);
}

function parse(args: string[]): { address?: string; chainKey: string; minDelaySec?: number; json: boolean } {
  let address: string | undefined;
  let chainKey = "ethereum";
  let minDelaySec: number | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error("--chain requires a value (e.g. --chain ethereum)");
      chainKey = args[++i];
    } else if (args[i] === "--min-delay") {
      const hours = Number(args[++i]);
      if (!Number.isFinite(hours) || hours < 0) throw new Error("--min-delay requires a non-negative number of hours");
      minDelaySec = Math.round(hours * 3600);
    } else if (args[i] === "--json") json = true;
    else if (!address) address = args[i];
  }
  return { address, chainKey, minDelaySec, json };
}
