import { Contract, formatUnits } from "ethers";
import { Route } from "../bridges.js";
import { chain } from "../config.js";
import { ERC20_ABI, getProvider, mapWithConcurrency, requireAddress, withRetry } from "../lib.js";
import { Observation } from "./storage.js";

/**
 * "My exposure" — for a given address, how much wrapped-bridge value do they
 * hold on each monitored route, and is that route currently backed? Read-only:
 * the wallet only ever supplies an address; nothing is signed, no transaction
 * is ever constructed.
 */

export interface ExposureRow {
  routeId: string;
  bridge: string;
  asset: string;
  mintChain: string;
  token: string;
  balance: string;
  balanceUsd: number | null;
  verdict: string | null;
  ratioPct: number | null;
  error?: string;
}

/** Balances of each route's minted token for `address`, joined with route status. */
export async function exposureFor(address: string, routes: Route[], latest: Observation[]): Promise<ExposureRow[]> {
  const holder = requireAddress(address, "address");
  const byId = new Map(latest.map((o) => [o.id, o]));

  const rows = await mapWithConcurrency(routes, 5, async (route): Promise<ExposureRow> => {
    const obs = byId.get(route.id);
    const base: ExposureRow = {
      routeId: route.id,
      bridge: route.bridge,
      asset: route.asset,
      mintChain: route.mint.chain,
      token: route.mint.token,
      balance: "0",
      balanceUsd: null,
      verdict: obs?.verdict ?? null,
      ratioPct: obs?.ratioPct ?? null,
    };
    try {
      const token = new Contract(
        requireAddress(route.mint.token, "mint token"),
        ERC20_ABI,
        getProvider(chain(route.mint.chain)),
      );
      const [raw, dec] = await Promise.all([
        withRetry(() => token.balanceOf(holder), { label: "balanceOf" }) as Promise<bigint>,
        withRetry(() => token.decimals(), { label: "decimals" }).then(Number),
      ]);
      const balance = formatUnits(raw, dec);
      const price = obs?.priceUsd;
      return {
        ...base,
        balance,
        balanceUsd: typeof price === "number" ? Number(balance) * price : null,
      };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Holdings first (largest USD value on top), then empty rows for completeness.
  const key = (r: ExposureRow): number => {
    const v = r.balanceUsd ?? Number(r.balance);
    return Number.isFinite(v) ? v : 0;
  };
  return rows.sort((a, b) => key(b) - key(a));
}
