/**
 * Dependency-manifest validation — pure logic, no network.
 *
 * `evmsec deps` audits the external, on-chain contracts your protocol *depends
 * on* — the USDC you hold, the Chainlink feed you price off, the bridge you route
 * through. Those are your on-chain supply chain: you inherit their upgrade admin,
 * their freeze authority, their oracle staleness. This validates the manifest
 * that lists them; the command runs the audit family over each entry.
 *
 * Manifest shape (`deps.json`):
 *   { "dependencies": [ { "label": "USDC", "chain": "ethereum", "address": "0x…" } ] }
 */

import { isAddress } from "ethers";

export interface Dependency {
  /** human label, e.g. "USDC" or "Chainlink ETH/USD". */
  label: string;
  chain: string;
  address: string;
}

export interface DepsValidation {
  deps: Dependency[];
  errors: string[];
}

/**
 * Validate a parsed manifest against the set of known chains. Returns the usable
 * dependencies and a list of human-readable errors (one per problem). Pure.
 */
export function validateDeps(raw: unknown, knownChains: readonly string[]): DepsValidation {
  const errors: string[] = [];
  const deps: Dependency[] = [];

  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { dependencies?: unknown }).dependencies)) {
    return { deps, errors: ['manifest must be an object with a "dependencies" array'] };
  }

  const list = (raw as { dependencies: unknown[] }).dependencies;
  list.forEach((entry, i) => {
    const where = `dependencies[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${where}: must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : undefined;
    const chain = typeof e.chain === "string" ? e.chain : undefined;
    const address = typeof e.address === "string" ? e.address : undefined;

    if (!chain) errors.push(`${where}: missing "chain"`);
    else if (!knownChains.includes(chain)) errors.push(`${where}: unknown chain "${chain}"`);
    if (!address) errors.push(`${where}: missing "address"`);
    else if (!isAddress(address)) errors.push(`${where}: invalid address "${address}"`);

    if (chain && knownChains.includes(chain) && address && isAddress(address)) {
      deps.push({ label: label ?? address, chain, address });
    }
  });

  if (deps.length === 0 && errors.length === 0) errors.push("manifest has no dependencies");
  return { deps, errors };
}
