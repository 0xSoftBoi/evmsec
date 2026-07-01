import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAsset, priceRouteFor, priceFromHops, usdValue, fmtUsd, PRICE_FEEDS } from "./usd-core.js";

test("normalizeAsset strips bridged suffixes and upper-cases", () => {
  assert.equal(normalizeAsset("USDC.e"), "USDC");
  assert.equal(normalizeAsset("usdc.b"), "USDC");
  assert.equal(normalizeAsset("DAI"), "DAI");
  assert.equal(normalizeAsset("cbETH"), "CBETH");
  assert.equal(normalizeAsset("  wbtc  "), "WBTC");
});

test("priceRouteFor resolves the registry via the normalized key", () => {
  assert.ok(priceRouteFor("USDC.e"), "USDC.e should resolve to the USDC feed");
  assert.equal(priceRouteFor("USDC.e"), PRICE_FEEDS.USDC);
  assert.equal(priceRouteFor("cbETH")?.hops.length, 2, "cbETH composes two hops");
  assert.equal(priceRouteFor("NOPE"), undefined);
});

test("every registered asset has at least one hop with a plausible address + pair", () => {
  for (const [asset, route] of Object.entries(PRICE_FEEDS)) {
    assert.ok(route.hops.length >= 1, `${asset} has no hops`);
    for (const h of route.hops) {
      assert.match(h.address, /^0x[0-9a-fA-F]{40}$/, `${asset} hop address malformed`);
      assert.match(h.pair, /\//, `${asset} hop pair should look like FOO/BAR`);
    }
  }
});

test("priceFromHops multiplies feed answers at their own decimals", () => {
  // BTC/USD at 8 decimals: 58570.85373135 * 1e8
  const btc = priceFromHops([{ answer: 5857085373135n, decimals: 8 }]);
  assert.ok(btc !== null);
  assert.ok(Math.abs(btc! - 58570.85373135) < 1e-6);

  // cbETH/ETH (18dp) × ETH/USD (8dp): 1.1338 ETH/cbETH × $1569.26/ETH
  const cbeth = priceFromHops([
    { answer: 1133849473747714000n, decimals: 18 },
    { answer: 156926385781n, decimals: 8 },
  ]);
  assert.ok(cbeth !== null);
  assert.ok(Math.abs(cbeth! - 1.133849473747714 * 1569.26385781) < 1e-3);
});

test("priceFromHops rejects empty and non-positive readings (no silent $0)", () => {
  assert.equal(priceFromHops([]), null);
  assert.equal(priceFromHops([{ answer: 0n, decimals: 8 }]), null);
  assert.equal(priceFromHops([{ answer: -1n, decimals: 8 }]), null);
  // one bad hop in a chain kills the whole price
  assert.equal(
    priceFromHops([
      { answer: 100n, decimals: 8 },
      { answer: 0n, decimals: 8 },
    ]),
    null,
  );
});

test("usdValue scales an 18-dp amount by the per-token price", () => {
  const oneToken = 10n ** 18n;
  assert.equal(usdValue(oneToken, 2.5), 2.5);
  // 1,185,015,109 tokens at ~$1 ≈ $1.185B
  const bn = 1_185_015_109n * 10n ** 18n;
  assert.ok(Math.abs(usdValue(bn, 0.99957) - 1_184_505_735) < 1_000);
});

test("fmtUsd is compact and signed", () => {
  assert.equal(fmtUsd(1_185_015_109), "$1.19B");
  assert.equal(fmtUsd(45_200_000), "$45.20M");
  assert.equal(fmtUsd(12_345), "$12.3K");
  assert.equal(fmtUsd(9.5), "$9.50");
  assert.equal(fmtUsd(-2_000_000), "-$2.00M");
  assert.equal(fmtUsd(NaN), "—");
});
