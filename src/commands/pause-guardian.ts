import { Contract } from "ethers";
import { ChainConfig, chain } from "../config.js";
import {
  EIP1967,
  ROLES,
  ZEPPELINOS,
  addrLink,
  addressFromSlot,
  addressKind,
  enumerateRoleHolders,
  getProvider,
  requireAddress,
  withRetry,
} from "../lib.js";
import { OwnerKind, RoleHolder } from "../mint-authority-core.js";
import { classifyPauseGuardian, classifyPauseSurface } from "../pause-guardian-core.js";

const PAUSE_ABI = ["function paused() view returns (bool)", "function owner() view returns (address)"];

/**
 * `evmsec pause-guardian <token> [--chain ethereum] [--json]`
 *
 * Can this token's transfers be frozen, is it frozen right now, and who holds
 * the pause key? A single EOA that can pause a wrapped asset is a liveness /
 * censorship vector — it can halt every holder at once. Follows the proxy to its
 * implementation, detects the Pausable surface + auth model, reads `paused()`,
 * and resolves the guardian (Ownable `owner()` or AccessControl `PAUSER_ROLE`).
 *
 * Exit code is non-zero when a single EOA can freeze transfers.
 */
export async function pauseGuardian(args: string[]): Promise<void> {
  const { address, chainKey, json } = parse(args);
  if (!address) throw new Error("usage: evmsec pause-guardian <token> [--chain ethereum] [--json]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  if (code === "0x") {
    if (json)
      console.log(JSON.stringify({ address: target, chain: c.key, error: "no code (EOA or undeployed)" }, null, 2));
    else console.log(`\n${target} on ${c.name} has no code (EOA or undeployed) — not a token.\n`);
    process.exitCode = 1;
    return;
  }

  const implementation = await resolveImplementation(provider, target);
  const scanned = implementation
    ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
    : code;
  const surface = classifyPauseSurface(scanned);

  // Current paused state (best-effort).
  let paused: boolean | null = null;
  if (surface.hasPausedView || surface.pausable) {
    try {
      paused = Boolean(
        await withRetry(() => new Contract(target, PAUSE_ABI, provider).paused(), { label: "paused()" }),
      );
    } catch {
      paused = null;
    }
  }

  // Resolve the guardian: PAUSER_ROLE holders for AccessControl, else owner().
  let guardian: string | null = null;
  let guardianKind: OwnerKind = "unknown";
  let pausers: RoleHolder[] | undefined;
  let pauserNote: string | undefined;

  if (surface.authModel === "access-control" || surface.authModel === "ownable+access-control") {
    const found = await enumerateRoleHolders(provider, target, ROLES.PAUSER);
    pauserNote = found.note;
    if (found.method !== "none") {
      pausers = [];
      for (const a of found.holders) pausers.push({ address: a, kind: await addressKind(provider, a) });
    }
  } else if (surface.authModel === "ownable") {
    try {
      const raw = (await withRetry(() => new Contract(target, PAUSE_ABI, provider).owner(), {
        label: "owner()",
      })) as string;
      guardian = requireAddress(raw, "owner");
      guardianKind = /^0x0+$/i.test(guardian) ? "renounced" : await addressKind(provider, guardian);
    } catch {
      guardianKind = "unknown";
    }
  }

  const verdict = classifyPauseGuardian(surface, paused, guardianKind, guardian, pausers);

  if (json) {
    console.log(
      JSON.stringify(
        {
          address: target,
          chain: c.key,
          implementation,
          pausable: surface.pausable,
          paused,
          authModel: surface.authModel,
          guardian,
          guardianKind,
          pausers: verdict.pausers ?? null,
          pauserNote: pauserNote ?? null,
          risk: verdict.risk,
          summary: verdict.summary,
          indicators: surface.indicators,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, target, implementation, pauserNote, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
}

async function resolveImplementation(provider: ReturnType<typeof getProvider>, target: string): Promise<string | null> {
  const [implWord, legacyWord] = await Promise.all([
    withRetry(() => provider.getStorage(target, EIP1967.implementation), { label: "impl slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.implementation), { label: "legacy impl slot" }),
  ]);
  return addressFromSlot(implWord) ?? addressFromSlot(legacyWord);
}

const RISK_MARK: Record<string, string> = { critical: "✗ CRITICAL", elevated: "⚠ ELEVATED", info: "· INFO" };

function print(
  c: ChainConfig,
  target: string,
  implementation: string | null,
  pauserNote: string | undefined,
  v: ReturnType<typeof classifyPauseGuardian>,
): void {
  const s = v.surface;
  console.log(`\nPause-guardian — ${target} on ${c.name}`);
  console.log("─".repeat(68));
  if (implementation) {
    console.log(`  proxy           yes — scanned implementation ${implementation}`);
    console.log(`                  ${addrLink(c, implementation)}`);
  }
  console.log(`  pausable        ${s.pausable ? "yes — transfers can be frozen" : "no pause entrypoint detected"}`);
  console.log(`  paused now       ${v.paused === null ? "unknown" : v.paused ? "YES — transfers frozen" : "no"}`);
  console.log(`  auth model      ${s.authModel}`);
  if (v.guardian) console.log(`  pause owner     ${v.guardian}  → ${v.guardianKind}`);
  if (v.pausers) {
    if (v.pausers.length === 0) console.log(`  PAUSER_ROLE     no current holders`);
    else
      for (const p of v.pausers)
        console.log(`  PAUSER_ROLE     ${p.address}  → ${p.kind === "eoa" ? "EOA (single key)" : "contract"}`);
  } else if (pauserNote) {
    console.log(`  PAUSER_ROLE     not enumerated — ${pauserNote}`);
  }
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  console.log(`  ${addrLink(c, target)}`);
  console.log(`\n  ${v.summary}`);
  console.log(`\n  indicators`);
  for (const ind of s.indicators) console.log(`    • ${ind}`);
  console.log(`\n  Heuristic from bytecode + on-chain reads — confirm pause gating against source.\n`);
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
