import { Contract } from "ethers";
import { ChainConfig, chain } from "../config.js";
import {
  EIP1967,
  ERC20_ABI,
  ZEPPELINOS,
  addrLink,
  addressFromSlot,
  getProvider,
  requireAddress,
  shortAddr,
  withRetry,
} from "../lib.js";
import { OwnerKind, classifyMintAuthority, classifyMintSurface } from "../mint-authority-core.js";

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
      if (/^0x0+$/i.test(owner)) {
        ownerKind = "renounced";
      } else {
        const ownerCode = await withRetry(() => provider.getCode(owner!), { label: "owner getCode" });
        ownerKind = ownerCode === "0x" ? "eoa" : "contract";
      }
    } catch {
      ownerKind = "unknown";
    }
  }

  const verdict = classifyMintAuthority(surface, ownerKind, owner);

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
          authModel: surface.authModel,
          mintEntrypoints: surface.mintEntrypoints,
          owner,
          ownerKind,
          risk: verdict.risk,
          summary: verdict.summary,
          indicators: surface.indicators,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, target, implementation, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
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
  console.log(`  pausable        ${s.pausable ? "yes — transfers can be frozen" : "no"}`);
  if (v.owner) console.log(`  owner           ${v.owner}  → ${OWNER_LABEL[v.ownerKind]}`);
  else console.log(`  owner           ${OWNER_LABEL[v.ownerKind]}`);
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  console.log(`  ${addrLink(c, target)}`);
  console.log(`\n  ${v.summary}`);
  console.log(`\n  indicators`);
  for (const ind of s.indicators) console.log(`    • ${ind}`);
  if (v.ownerKind === "eoa" && v.owner) {
    console.log(`\n  ⚠ owner() is a single EOA (${shortAddr(v.owner)}); if it gates minting,`);
    console.log(`    one compromised key can print unbacked supply.`);
  }
  console.log(`\n  Heuristic from bytecode — confirm mint gating against the token's source.\n`);
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
