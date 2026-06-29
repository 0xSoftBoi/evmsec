import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ChainKey } from "./config.js";

/** One locked leg: a token held in an escrow on some chain. */
export interface LockLeg {
  chain: ChainKey;
  escrow: string;
  token: string;
}

/**
 * A lock-and-mint route. The invariant a solvent bridge must hold:
 *
 *   Σ balanceOf(leg.token @ leg.escrow)  >=  totalSupply(mint.token)
 *
 * i.e. every wrapped unit minted on the destination chain is backed by a real
 * unit locked in escrow on the source chain(s). A deficit is the money printer.
 *
 * `lock` is a single leg or an array of legs — the multi-asset / multi-escrow
 * case sums them (each normalized to 18 dp). The legs must denominate the **same
 * unit** as the minted token; summing differently-priced assets needs an oracle
 * and is deliberately out of scope.
 */
export interface Route {
  /** stable id, e.g. "polygon-pos-usdc" */
  id: string;
  /** human bridge name, e.g. "Polygon PoS" */
  bridge: string;
  /** asset label, e.g. "USDC" */
  asset: string;
  lock: LockLeg | LockLeg[];
  mint: { chain: ChainKey; token: string };
  notes?: string;
  /**
   * Whether this route's addresses are verified against a primary source.
   * Defaults to true; the registry validator requires a source URL in `notes`
   * unless this is explicitly `false` (a deliberately-illustrative entry).
   */
  verified?: boolean;
}

/** Normalize a route's `lock` to an array of legs (single-leg stays one entry). */
export function lockLegs(route: Route): LockLeg[] {
  return Array.isArray(route.lock) ? route.lock : [route.lock];
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Load the route registry. Defaults to the bundled bridges.json; override with
 * EVMSEC_BRIDGES=/path/to/your.json to point at your own verified set.
 *
 * NOTE: bundled addresses are illustrative and must be verified before you
 * trust a result — a security tool fed wrong addresses lies confidently.
 */
export function loadRoutes(): Route[] {
  const path = process.env.EVMSEC_BRIDGES ?? join(here, "..", "bridges.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { routes: Route[] };
  if (!Array.isArray(parsed.routes)) {
    throw new Error(`${path}: expected { "routes": [...] }`);
  }
  return parsed.routes;
}

export function findRoute(id: string): Route {
  const routes = loadRoutes();
  const hit = routes.find((r) => r.id === id);
  if (!hit) {
    throw new Error(`unknown route "${id}". Known: ${routes.map((r) => r.id).join(", ") || "(none)"}`);
  }
  return hit;
}
