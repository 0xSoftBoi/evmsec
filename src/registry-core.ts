import { getAddress } from "ethers";
import { CHAINS, ChainKey } from "./config.js";

/**
 * Registry validation — pure logic, no network.
 *
 * The `bridges.json` registry is only trustworthy if every address traces to a
 * primary source and is well-formed. **A security tool fed the wrong escrow lies
 * confidently** — so this enforces machine-checkable invariants that CI can gate
 * a registry PR on, rather than relying on review alone.
 *
 * Rules (errors block CI; warnings advise):
 *   - top-level shape is `{ "routes": [...] }`
 *   - each route id is unique and kebab-case
 *   - bridge / asset are non-empty strings
 *   - every chain is one this tool knows (`src/config.ts`)
 *   - every escrow/token address is EIP-55 **checksummed** (exact match)
 *   - a route claiming to be verified (the default) must cite a source URL in
 *     `notes`; mark a deliberately-illustrative route `"verified": false` to
 *     opt out (it is still structurally validated)
 */

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  routeCount: number;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_RE = /https?:\/\/\S+/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function knownChain(v: unknown): v is ChainKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CHAINS, v);
}

/** Push an error unless `addr` is a non-empty, EIP-55 checksummed address. */
function checkAddress(addr: unknown, where: string, errors: string[]): void {
  if (typeof addr !== "string" || addr.length === 0) {
    errors.push(`${where}: missing address`);
    return;
  }
  let checksummed: string;
  try {
    checksummed = getAddress(addr);
  } catch {
    errors.push(`${where}: "${addr}" is not a valid address`);
    return;
  }
  if (checksummed !== addr) {
    errors.push(`${where}: "${addr}" is not EIP-55 checksummed (expected ${checksummed})`);
  }
}

function validateLeg(leg: unknown, where: string, errors: string[]): void {
  if (!isObject(leg)) {
    errors.push(`${where}: each lock leg must be an object { chain, escrow, token }`);
    return;
  }
  if (!knownChain(leg.chain)) {
    errors.push(`${where}: unknown chain ${JSON.stringify(leg.chain)} (known: ${Object.keys(CHAINS).join(", ")})`);
  }
  checkAddress(leg.escrow, `${where}.escrow`, errors);
  checkAddress(leg.token, `${where}.token`, errors);
}

function validateRoute(route: unknown, index: number, seenIds: Set<string>, result: ValidationResult): void {
  const at = `routes[${index}]`;
  if (!isObject(route)) {
    result.errors.push(`${at}: must be an object`);
    return;
  }

  // id
  const id = route.id;
  if (typeof id !== "string" || id.length === 0) {
    result.errors.push(`${at}: missing "id"`);
  } else {
    const label = `${at} (id "${id}")`;
    if (!ID_RE.test(id)) result.errors.push(`${label}: id must be kebab-case ([a-z0-9] and hyphens)`);
    if (seenIds.has(id)) result.errors.push(`${label}: duplicate id`);
    seenIds.add(id);
  }

  const idLabel = typeof id === "string" ? `${at} (id "${id}")` : at;

  for (const field of ["bridge", "asset"] as const) {
    if (typeof route[field] !== "string" || (route[field] as string).length === 0) {
      result.errors.push(`${idLabel}: missing "${field}"`);
    }
  }

  // lock: a single leg or an array of legs (>= 1)
  if (route.lock === undefined) {
    result.errors.push(`${idLabel}: missing "lock"`);
  } else {
    const legs = Array.isArray(route.lock) ? route.lock : [route.lock];
    if (legs.length === 0) result.errors.push(`${idLabel}: "lock" array is empty`);
    legs.forEach((leg, i) => validateLeg(leg, `${idLabel}.lock[${i}]`, result.errors));
  }

  // mint: { chain, token }
  if (!isObject(route.mint)) {
    result.errors.push(`${idLabel}: missing "mint" { chain, token }`);
  } else {
    if (!knownChain(route.mint.chain)) {
      result.errors.push(`${idLabel}.mint: unknown chain ${JSON.stringify(route.mint.chain)}`);
    }
    checkAddress(route.mint.token, `${idLabel}.mint.token`, result.errors);
  }

  // notes + source citation. `verified: false` opts a route out of the source
  // requirement (but it's still structurally validated above).
  const verified = route.verified !== false; // default: claims to be verified
  const notes = typeof route.notes === "string" ? route.notes : "";
  if (verified) {
    if (!notes) {
      result.errors.push(
        `${idLabel}: a verified route must cite a primary source in "notes" (or set "verified": false)`,
      );
    } else if (!URL_RE.test(notes)) {
      result.errors.push(`${idLabel}: "notes" must include a primary-source URL (or set "verified": false)`);
    }
  } else if (!notes) {
    result.warnings.push(`${idLabel}: illustrative route (verified=false) — consider citing a source anyway`);
  }
}

/** Validate a parsed `bridges.json` object. Pure; returns structured results. */
export function validateRegistry(data: unknown): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [], routeCount: 0 };

  if (!isObject(data) || !Array.isArray(data.routes)) {
    result.errors.push(`top level must be an object of the form { "routes": [ ... ] }`);
    return result;
  }

  result.routeCount = data.routes.length;
  if (data.routes.length === 0) result.warnings.push("registry has no routes");

  const seenIds = new Set<string>();
  data.routes.forEach((route, i) => validateRoute(route, i, seenIds, result));
  return result;
}
