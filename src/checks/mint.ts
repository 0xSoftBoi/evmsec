import { Contract } from "ethers";
import { Check, CheckContext, CheckReport, Severity, report } from "../check.js";
import { ERC20_ABI, ROLES, addressKind, enumerateRoleHolders, requireAddress, withRetry } from "../lib.js";
import { OwnerKind, RoleHolder, classifyMintAuthority, classifyMintSurface } from "../mint-authority-core.js";
import { readCap, resolveImplementation } from "./onchain.js";

const MASTER_MINTER_ABI = ["function masterMinter() view returns (address)"];

/**
 * Can the supply be inflated later, and by whom? Scans the bytecode for
 * mint/burn entrypoints and the auth model, then resolves the actual authority —
 * `owner()`, the enumerated `MINTER_ROLE` holders, or a FiatToken `masterMinter`.
 */
export const mintAuthorityCheck: Check = {
  id: "mint-authority",
  title: "Mint authority",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const { provider, target, code } = ctx;
    const implementation = await resolveImplementation(provider, target);
    const scanned = implementation
      ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
      : code;
    const surface = classifyMintSurface(scanned);

    let owner: string | null = null;
    let ownerKind: OwnerKind = "unknown";
    if (surface.authModel === "ownable" || surface.authModel === "ownable+access-control") {
      try {
        const raw = (await withRetry(() => new Contract(target, ERC20_ABI, provider).owner(), {
          label: "owner()",
        })) as string;
        owner = requireAddress(raw, "owner");
        ownerKind = /^0x0+$/i.test(owner) ? "renounced" : await addressKind(provider, owner);
      } catch {
        ownerKind = "unknown";
      }
    }

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

    const cap = surface.capped ? await readCap(provider, target) : null;

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

    const evidence: CheckReport["evidence"] = {
      mintable: surface.mintable,
      "auth model": surface.authModel,
      "supply cap": surface.capped ? (cap ?? "yes (value unread)") : "none (uncapped)",
    };
    if (implementation) evidence.implementation = implementation;
    if (owner) evidence.owner = owner;
    if (masterMinter) evidence.masterMinter = masterMinter.address;

    const notes: string[] = [];
    if (minters) {
      if (minters.length === 0) notes.push("MINTER_ROLE: no current holders");
      else for (const m of minters) notes.push(`MINTER_ROLE: ${m.address} (${m.kind})`);
    } else if (minterNote) {
      notes.push(`MINTER_ROLE not enumerated — ${minterNote}`);
    }

    const severity: Severity = verdict.fail ? "critical" : verdict.risk === "elevated" ? "warning" : "ok";
    return report({ id: this.id, title: this.title, severity, summary: verdict.summary, evidence, notes });
  },
};
