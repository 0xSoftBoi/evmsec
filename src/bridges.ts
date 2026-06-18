import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ChainKey } from "./config.js";

/**
 * A lock-and-mint route. The invariant a solvent bridge must hold:
 *
 *   balanceOf(lock.token @ lock.escrow)  >=  totalSupply(mint.token)
 *
 * i.e. every wrapped unit minted on the destination chain is backed by a real
 * unit locked in escrow on the source chain. A deficit is the money printer.
 */
export interface Route {
  /** stable id, e.g. "polygon-pos-usdc" */
  id: string;
  /** human bridge name, e.g. "Polygon PoS" */
  bridge: string;
  /** asset label, e.g. "USDC" */
  asset: string;
  lock: { chain: ChainKey; escrow: string; token: string };
  mint: { chain: ChainKey; token: string };
  notes?: string;
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
    throw new Error(
      `unknown route "${id}". Known: ${routes.map((r) => r.id).join(", ") || "(none)"}`,
    );
  }
  return hit;
}
