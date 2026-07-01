/**
 * Pure USD-valuation helpers — no network. A route's collateral is denominated
 * in a token (USDC, WBTC, cbETH…); to turn "1,185,015,109 USDC.e locked" into
 * "$1.18B locked" we read a Chainlink price feed on-chain and multiply. The feed
 * *reads* happen in the command (network); everything here is deterministic math
 * over those readings, so it's unit-tested.
 *
 * Feeds are the canonical Chainlink aggregators on Ethereum mainnet, each
 * verified live (description + decimals + a sane latestRoundData) before being
 * pinned here. Stablecoin feeds (USDC/USD, DAI/USD) are read too rather than
 * assumed == $1, so a depeg shows up in the dollar figure instead of hiding.
 */

/** Minimal Chainlink AggregatorV3 surface the command calls. */
export const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
] as const;

/** A single Chainlink feed to read. */
export interface FeedHop {
  /** Aggregator address on Ethereum mainnet. */
  address: string;
  /** e.g. "BTC/USD" — for provenance in output. */
  pair: string;
}

/** How to price one asset: multiply the hops' answers together. */
export interface PriceRoute {
  hops: FeedHop[];
  /** Caveat worth surfacing (e.g. WBTC priced off BTC, custody assumed 1:1). */
  note?: string;
}

const ETH_USD: FeedHop = { address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", pair: "ETH/USD" };

/**
 * Asset → how to value it in USD. Keyed by the *normalized* asset symbol
 * (see {@link normalizeAsset}), so USDC and USDC.e share one entry.
 */
export const PRICE_FEEDS: Record<string, PriceRoute> = {
  USDC: { hops: [{ address: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", pair: "USDC/USD" }] },
  DAI: { hops: [{ address: "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", pair: "DAI/USD" }] },
  LINK: { hops: [{ address: "0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c", pair: "LINK/USD" }] },
  WETH: { hops: [ETH_USD] },
  ETH: { hops: [ETH_USD] },
  // WBTC has no direct USD feed; BTC/USD is the standard proxy. The peg is a
  // custody assumption (1 WBTC ↔ 1 BTC), independent of this backing check.
  WBTC: {
    hops: [{ address: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", pair: "BTC/USD" }],
    note: "priced via BTC/USD; WBTC↔BTC is a custody assumption",
  },
  // cbETH has no direct USD feed on mainnet; compose cbETH/ETH × ETH/USD.
  CBETH: {
    hops: [{ address: "0xF017fcB346A1885194689bA23Eff2fE6fA5C483b", pair: "cbETH/ETH" }, ETH_USD],
  },
};

/** Bridged-variant labels that price the same as a canonical asset. */
const ALIASES: Record<string, string> = {
  USDBC: "USDC", // Base's bridged USDC
  "USDC.E": "USDC",
  WBTC: "WBTC",
};

/**
 * Canonical pricing key for an asset label: strip a bridged-variant suffix,
 * upper-case, then fold known aliases (USDbC/USDC.e → USDC). "cbETH" → "CBETH".
 */
export function normalizeAsset(asset: string): string {
  const base = asset
    .trim()
    .replace(/\.(e|b)$/i, "")
    .toUpperCase();
  return ALIASES[base] ?? base;
}

/** The pricing route for an asset symbol, or undefined if we can't value it. */
export function priceRouteFor(asset: string): PriceRoute | undefined {
  return PRICE_FEEDS[normalizeAsset(asset)];
}

/** One feed reading: the raw answer and the feed's own decimals. */
export interface HopReading {
  answer: bigint;
  decimals: number;
}

/**
 * USD price of one whole token, from its feed hops multiplied together. Returns
 * null if any hop is missing or non-positive (a stale/broken feed shouldn't
 * silently value collateral at $0). Float result — display precision, not
 * accounting precision.
 */
export function priceFromHops(readings: HopReading[]): number | null {
  if (readings.length === 0) return null;
  let price = 1;
  for (const r of readings) {
    if (r.answer <= 0n) return null;
    price *= Number(r.answer) / 10 ** r.decimals;
  }
  return price;
}

/**
 * USD value of an 18-dp token amount at `pricePerToken` dollars. `amount18` is
 * the common fixed-point the solvency core already sums legs into. Float math —
 * fine for a headline dollar figure (~$B), not for reconciling wei.
 */
export function usdValue(amount18: bigint, pricePerToken: number): number {
  return (Number(amount18) / 1e18) * pricePerToken;
}

/** Compact currency: $1.18B, $45.2M, $12.3K, $9.50. Signed for deltas. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
