import { Contract } from "ethers";
import { ChainConfig, chain } from "../config.js";
import {
  EIP1967,
  ERC20_ABI,
  ROLES,
  ZEPPELINOS,
  addrLink,
  addressFromSlot,
  addressKind,
  enumerateRoleHolders,
  getProvider,
  requireAddress,
  shortAddr,
  withRetry,
} from "../lib.js";
import { OwnerKind, RoleHolder, classifyMintAuthority, classifyMintSurface } from "../mint-authority-core.js";

const CAP_ABI = ["function cap() view returns (uint256)", "function maxSupply() view returns (uint256)"];
const MASTER_MINTER_ABI = ["function masterMinter() view returns (address)"];

/**
 * `evmsec mint-authority <token> [--chain ethereum] [--json]`
 *
 * `solvency` checks a bridge is backed *now*; this asks the next question every
 * auditor asks: **can the wrapped supply be inflated later, and by whom?** It
 * reads the token's deployed bytecode for mint/burn/pause entrypoints and its
 * auth model (Ownable / AccessControl), then resolves `owner()` on-chain and
 * classifies it (renounced / single EOA / contract).
 *
 * Exit code is non-zero when an inflatable supply sits under a single EOA key —
 * a clear rug vector — so it drops into CI alongside `solvency`.
 */
export async function mintAuthority(args: string[]): Promise<void> {
  const { address, chainKey, json } = parse(args);
  if (!address) throw new Error("usage: evmsec mint-authority <token> [--chain ethereum] [--json]");

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

  // Most bridge tokens are proxies — the mint functions live in the
  // implementation, not the proxy stub. Follow EIP-1967 (or the legacy
  // zeppelinos slot) and scan the implementation bytecode so we don't report
  // "no mint entrypoint" on exactly the tokens that matter.
  const implementation = await resolveImplementation(provider, target);
  const scanned = implementation
    ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
    : code;
  const surface = classifyMintSurface(scanned);

  // Resolve owner() only if the bytecode advertises an Ownable interface.
  let owner: string | null = null;
  let ownerKind: OwnerKind = "unknown";
  if (surface.authModel === "ownable" || surface.authModel === "ownable+access-control") {
    const token = new Contract(target, ERC20_ABI, provider);
    try {
      const raw = (await withRetry(() => token.owner(), { label: "owner()" })) as string;
      owner = requireAddress(raw, "owner");
      ownerKind = /^0x0+$/i.test(owner) ? "renounced" : await addressKind(provider, owner);
    } catch {
      ownerKind = "unknown";
    }
  }

  // For AccessControl tokens, enumerate the actual MINTER_ROLE holders and
  // classify each — this turns "role-gated, go look" into a concrete answer.
  let minters: RoleHolder[] | undefined;
  let minterNote: string | undefined;
  if (surface.authModel === "access-control" || surface.authModel === "ownable+access-control") {
    const found = await enumerateRoleHolders(provider, target, ROLES.MINTER);
    minterNote = found.note;
    if (found.method !== "none") {
      minters = [];
      for (const a of found.holders) minters.push({ address: a, kind: await addressKind(provider, a) });
    }
  }

  // Best-effort read of the supply cap value, if the surface advertised one.
  const cap = surface.capped ? await readCap(provider, target) : null;

  // FiatToken (USDC-class): resolve the masterMinter that actually gates minting.
  let masterMinter: RoleHolder | null = null;
  if (surface.hasMasterMinter) {
    try {
      const raw = (await withRetry(() => new Contract(target, MASTER_MINTER_ABI, provider).masterMinter(), {
        label: "masterMinter()",
      })) as string;
      const addr = requireAddress(raw, "masterMinter");
      masterMinter = { address: addr, kind: await addressKind(provider, addr) };
    } catch {
      masterMinter = null;
    }
  }

  const verdict = classifyMintAuthority(surface, ownerKind, owner, minters, masterMinter);

  if (json) {
    console.log(
      JSON.stringify(
        {
          address: target,
          chain: c.key,
          implementation,
          mintable: surface.mintable,
          burnable: surface.burnable,
          pausable: surface.pausable,
          capped: surface.capped,
          cap,
          authModel: surface.authModel,
          mintEntrypoints: surface.mintEntrypoints,
          owner,
          ownerKind,
          masterMinter,
          minters: verdict.minters ?? null,
          minterNote: minterNote ?? null,
          risk: verdict.risk,
          summary: verdict.summary,
          indicators: surface.indicators,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, target, implementation, cap, minterNote, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
}

/** Read cap()/maxSupply() as a string, or null if neither is callable. */
async function readCap(provider: ReturnType<typeof getProvider>, target: string): Promise<string | null> {
  const token = new Contract(target, CAP_ABI, provider);
  for (const fn of ["cap", "maxSupply"] as const) {
    try {
      return String((await withRetry(() => token[fn](), { label: fn })) as bigint);
    } catch {
      // try the next getter
    }
  }
  return null;
}

/** Follow EIP-1967 / legacy zeppelinos implementation slots; null if not a proxy. */
async function resolveImplementation(provider: ReturnType<typeof getProvider>, target: string): Promise<string | null> {
  const [implWord, legacyWord] = await Promise.all([
    withRetry(() => provider.getStorage(target, EIP1967.implementation), { label: "impl slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.implementation), { label: "legacy impl slot" }),
  ]);
  return addressFromSlot(implWord) ?? addressFromSlot(legacyWord);
}

const RISK_MARK: Record<string, string> = { critical: "✗ CRITICAL", elevated: "⚠ ELEVATED", info: "· INFO" };
const OWNER_LABEL: Record<OwnerKind, string> = {
  renounced: "renounced (owner is the zero address)",
  eoa: "EOA (single key)",
  contract: "contract (multisig / timelock — inspect it)",
  unknown: "not determinable from bytecode",
};

function print(
  c: ChainConfig,
  target: string,
  implementation: string | null,
  cap: string | null,
  minterNote: string | undefined,
  v: ReturnType<typeof classifyMintAuthority>,
): void {
  const s = v.surface;
  console.log(`\nMint-authority — ${target} on ${c.name}`);
  console.log("─".repeat(68));
  if (implementation) {
    console.log(`  proxy           yes — scanned implementation ${implementation}`);
    console.log(`                  ${addrLink(c, implementation)}`);
  }
  console.log(`  mintable        ${s.mintable ? "yes" : "no recognized mint entrypoint"}`);
  if (s.mintEntrypoints.length) console.log(`  entrypoints     ${s.mintEntrypoints.join(", ")}`);
  console.log(`  auth model      ${s.authModel}`);
  console.log(
    `  supply cap      ${s.capped ? (cap !== null ? cap : "yes (value unread)") : "none detected (uncapped)"}`,
  );
  console.log(`  pausable        ${s.pausable ? "yes — transfers can be frozen" : "no"}`);
  if (v.owner) console.log(`  owner           ${v.owner}  → ${OWNER_LABEL[v.ownerKind]}`);
  else if (s.authModel === "ownable" || s.authModel === "ownable+access-control")
    console.log(`  owner           ${OWNER_LABEL[v.ownerKind]}`);
  if (s.hasMasterMinter) {
    const mm = v.masterMinter;
    console.log(
      `  masterMinter    ${mm ? `${mm.address}  → ${mm.kind === "eoa" ? "EOA (single key)" : "contract"}` : "present (unreadable)"}`,
    );
  }
  if (v.minters) {
    if (v.minters.length === 0) console.log(`  MINTER_ROLE     no current holders`);
    else
      for (const m of v.minters)
        console.log(`  MINTER_ROLE     ${m.address}  → ${m.kind === "eoa" ? "EOA (single key)" : "contract"}`);
  } else if (minterNote) {
    console.log(`  MINTER_ROLE     not enumerated — ${minterNote}`);
  }
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  console.log(`  ${addrLink(c, target)}`);
  console.log(`\n  ${v.summary}`);
  console.log(`\n  indicators`);
  for (const ind of s.indicators) console.log(`    • ${ind}`);
  if (v.ownerKind === "eoa" && v.owner) {
    console.log(`\n  ⚠ owner() is a single EOA (${shortAddr(v.owner)}); if it gates minting,`);
    console.log(`    one compromised key can print unbacked supply.`);
  }
  console.log(`\n  Heuristic from bytecode + on-chain reads — confirm mint gating against source.\n`);
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
