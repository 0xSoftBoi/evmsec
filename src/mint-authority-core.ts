/**
 * Mint-authority classification — pure logic, no network.
 *
 * `solvency` answers "is the wrapped supply backed *right now*?" But a bridge
 * token can read 100% backed today and still carry an open mint function — a
 * future money printer one key away from being used. The Nomad/Wormhole-class
 * question this complements is: **who, if anyone, can inflate the supply?**
 *
 * We can't read intent from bytecode, but we CAN see the capability surface a
 * token exposes: which mint/burn entrypoints exist, whether it uses Ownable or
 * OpenZeppelin AccessControl, and whether it is pausable. Combined with an
 * on-chain `owner()` read (done by the command, not here), that gives an honest
 * picture of the centralization / inflation risk. Heuristic, not a proof —
 * confirm gating against the verifier's source.
 */

/** A 4-byte function selector we recognize, with a human label. */
interface KnownSelector {
  selector: string; // 8 hex chars, no 0x
  label: string;
  /** A mint entrypoint = supply can grow. */
  mints?: boolean;
  /** Part of the OpenZeppelin AccessControl machinery. */
  accessControl?: boolean;
  /** Ownable / Ownable2Step ownership machinery. */
  ownable?: boolean;
  /** Pausable machinery. */
  pausable?: boolean;
  /** A burn entrypoint = supply can shrink. */
  burns?: boolean;
  /** A supply-cap getter = inflation is bounded. */
  caps?: boolean;
  /** A FiatToken-style masterMinter() = minting is gated by a separate role. */
  masterMinter?: boolean;
}

// Selectors are first-4-bytes of keccak256(signature); values are verified in the
// unit test by recomputing them from the signatures, so they can't silently rot.
export const MINT_SELECTORS: KnownSelector[] = [
  { selector: "40c10f19", label: "mint(address,uint256)", mints: true },
  { selector: "a0712d68", label: "mint(uint256)", mints: true },
  { selector: "6a627842", label: "mint(address)", mints: true },
  { selector: "94d008ef", label: "mint(address,uint256,bytes)", mints: true },
  { selector: "8da5cb5b", label: "owner()", ownable: true },
  { selector: "e30c3978", label: "pendingOwner() (Ownable2Step)", ownable: true },
  { selector: "91d14854", label: "hasRole(bytes32,address) (AccessControl)", accessControl: true },
  { selector: "248a9ca3", label: "getRoleAdmin(bytes32) (AccessControl)", accessControl: true },
  { selector: "2f2ff15d", label: "grantRole(bytes32,address) (AccessControl)", accessControl: true },
  { selector: "5c975abb", label: "paused()", pausable: true },
  { selector: "8456cb59", label: "pause()", pausable: true },
  { selector: "355274ea", label: "cap() (ERC20Capped)", caps: true },
  { selector: "d5abeb01", label: "maxSupply()", caps: true },
  { selector: "35d99f35", label: "masterMinter() (FiatToken)", masterMinter: true },
  { selector: "42966c68", label: "burn(uint256)", burns: true },
  { selector: "79cc6790", label: "burnFrom(address,uint256)", burns: true },
];

const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;

/**
 * Scan deployed bytecode for the 4-byte selectors in a token's function
 * dispatcher. Walks opcodes, correctly skipping PUSH immediates so a selector
 * value sitting inside pushed data isn't mistaken for a dispatch entry.
 */
export function scanSelectors(bytecode: string, known: KnownSelector[] = MINT_SELECTORS): KnownSelector[] {
  if (!bytecode || bytecode === "0x") return [];
  const hex = bytecode.toLowerCase().replace(/^0x/, "");
  const bytes: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));

  const byValue = new Map(known.map((k) => [k.selector, k]));
  const hits = new Map<string, KnownSelector>();
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === PUSH4) {
      let sel = "";
      for (let j = 1; j <= 4 && i + j < bytes.length; j++) sel += bytes[i + j].toString(16).padStart(2, "0");
      const k = byValue.get(sel);
      if (k && sel.length === 8) hits.set(sel, k);
      i += 4;
    } else if (op >= PUSH1 && op <= PUSH32) {
      i += op - PUSH1 + 1; // skip the immediate
    }
  }
  return [...hits.values()];
}

/** How the contract gates privileged actions, as seen in bytecode. */
export type AuthModel = "ownable" | "access-control" | "ownable+access-control" | "none-detected";

/** Classification of the owner address (filled in by the command after an `owner()` read). */
export type OwnerKind = "renounced" | "eoa" | "contract" | "unknown";

export interface MintSurface {
  mintable: boolean;
  burnable: boolean;
  pausable: boolean;
  /** a supply-cap getter (cap()/maxSupply()) is present — inflation is bounded. */
  capped: boolean;
  /** a FiatToken-style masterMinter() is present — minting is gated by it, not owner(). */
  hasMasterMinter: boolean;
  authModel: AuthModel;
  mintEntrypoints: string[]; // human labels of mint functions found
  indicators: string[];
}

/** Classify the capability surface of a token from its deployed bytecode. */
export function classifyMintSurface(bytecode: string): MintSurface {
  const found = scanSelectors(bytecode);
  const mintEntrypoints = found.filter((f) => f.mints).map((f) => f.label);
  const mintable = mintEntrypoints.length > 0;
  const burnable = found.some((f) => f.burns);
  const pausable = found.some((f) => f.pausable);
  const capped = found.some((f) => f.caps);
  const hasMasterMinter = found.some((f) => f.masterMinter);
  const ownable = found.some((f) => f.ownable);
  const accessControl = found.some((f) => f.accessControl);

  const authModel: AuthModel =
    ownable && accessControl
      ? "ownable+access-control"
      : accessControl
        ? "access-control"
        : ownable
          ? "ownable"
          : "none-detected";

  const indicators: string[] = [];
  if (mintable) indicators.push(`mint entrypoint(s) present: ${mintEntrypoints.join(", ")}`);
  else indicators.push("no recognized mint entrypoint in bytecode (supply may be fixed — confirm from source)");
  if (accessControl)
    indicators.push("OpenZeppelin AccessControl — minting is likely gated by a role (e.g. MINTER_ROLE)");
  if (ownable) indicators.push("Ownable owner() present — privileged actions gated by a single owner");
  if (capped) indicators.push("supply-cap getter present — minting is bounded by a cap (confirm the cap value)");
  if (hasMasterMinter)
    indicators.push("FiatToken masterMinter() present — minting is gated by the masterMinter, not owner()");
  if (pausable) indicators.push("pausable — transfers can be frozen by the pause authority");

  return { mintable, burnable, pausable, capped, hasMasterMinter, authModel, mintEntrypoints, indicators };
}

/** A resolved holder of a role (e.g. MINTER_ROLE), classified by address kind. */
export interface RoleHolder {
  address: string;
  kind: OwnerKind; // "eoa" | "contract" (others unused here)
}

export type MintRisk = "critical" | "elevated" | "info";

export interface MintAuthorityVerdict {
  surface: MintSurface;
  ownerKind: OwnerKind;
  owner: string | null;
  /** resolved MINTER_ROLE holders, when the token uses AccessControl. */
  minters?: RoleHolder[];
  /** resolved masterMinter, for FiatToken-style tokens. */
  masterMinter?: RoleHolder | null;
  risk: MintRisk;
  /** true when CI should fail: an inflatable supply controlled by a single key. */
  fail: boolean;
  summary: string;
}

/**
 * Fold the bytecode surface, the resolved owner, and (when AccessControl)
 * resolved MINTER_ROLE holders into a risk verdict.
 *
 * The sharpest signal is a *mintable* token whose mint authority is a live EOA:
 * one key can print unbacked supply. For Ownable tokens that authority is
 * `owner()`; for AccessControl tokens it's any MINTER_ROLE holder — if the
 * command resolved them, an EOA minter escalates the verdict to critical. When
 * holders couldn't be resolved we stay at "elevated" and say so rather than
 * pretending to a verdict the data doesn't support.
 */
export function classifyMintAuthority(
  surface: MintSurface,
  ownerKind: OwnerKind,
  owner: string | null,
  minters?: RoleHolder[],
  masterMinter?: RoleHolder | null,
): MintAuthorityVerdict {
  const isAccessControl = surface.authModel === "access-control" || surface.authModel === "ownable+access-control";
  const capNote = surface.capped ? " Inflation is bounded by a supply cap — confirm the cap value." : "";
  let risk: MintRisk = "info";
  let summary: string;
  let fail = false;

  if (!surface.mintable && !isAccessControl && !surface.hasMasterMinter) {
    risk = "info";
    summary = "no mint entrypoint detected — supply may be fixed; confirm against source.";
  } else if (surface.hasMasterMinter) {
    // FiatToken (USDC-class): mint is gated by the masterMinter, which configures
    // minters — not by owner() or OZ roles. This takes precedence.
    if (!masterMinter) {
      risk = "elevated";
      summary = `minting is gated by a FiatToken masterMinter that couldn't be read — resolve and verify it is a controller/multisig.${capNote}`;
    } else if (masterMinter.kind === "eoa") {
      risk = "critical";
      fail = true;
      summary = `minting is gated by a masterMinter held by a single EOA (${masterMinter.address}) — it can authorize unlimited minters.${capNote}`;
    } else {
      risk = "elevated";
      summary = `minting is gated by a masterMinter contract (${masterMinter.address}) — likely a controller/multisig; inspect it.${capNote}`;
    }
  } else if (isAccessControl) {
    const eoaMinters = (minters ?? []).filter((m) => m.kind === "eoa");
    if (eoaMinters.length) {
      risk = "critical";
      fail = true;
      summary =
        `minting is role-gated, and ${eoaMinters.length} MINTER_ROLE holder(s) are EOAs ` +
        `(${eoaMinters.map((m) => m.address).join(", ")}) — a single key can mint unbacked supply.${capNote}`;
    } else if (minters && minters.length) {
      risk = "elevated";
      summary =
        `minting is role-gated; ${minters.length} MINTER_ROLE holder(s), all contracts — ` +
        `verify each is a timelock/multisig (try \`evmsec upgradeability <holder>\`).${capNote}`;
    } else if (minters && minters.length === 0) {
      risk = "info";
      summary = `minting is role-gated and no address currently holds MINTER_ROLE — supply is not mintable right now (an admin could grant the role).${capNote}`;
    } else {
      risk = "elevated";
      summary = `minting is role-gated (AccessControl); MINTER_ROLE holders couldn't be enumerated — verify them against an indexer.${capNote}`;
    }
  } else if (ownerKind === "eoa") {
    risk = "critical";
    fail = true;
    summary =
      `a mint entrypoint exists and owner() is a single EOA (${owner}). If minting is owner-gated, ` +
      `one key can print unbacked supply — confirm the mint gating (some tokens route minting through a ` +
      `separate minter/masterMinter role).${capNote}`;
  } else if (ownerKind === "contract") {
    risk = "elevated";
    summary = `mint authority is a contract (owner ${owner}) — likely a multisig/timelock; inspect it (try \`evmsec upgradeability ${owner}\`).${capNote}`;
  } else if (ownerKind === "renounced") {
    risk = "info";
    summary = `ownership renounced — if minting is owner-gated, supply is effectively capped; confirm no other minter path.${capNote}`;
  } else {
    risk = "elevated";
    summary = `a mint entrypoint exists but the controlling authority couldn't be determined — verify from source.${capNote}`;
  }

  return { surface, ownerKind, owner, minters, masterMinter, risk, fail, summary };
}
