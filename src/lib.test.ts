import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  to18,
  backingPct,
  isUnderBacked,
  firstBreachBlock,
  addressFromSlot,
  bytes32ToAddress,
  EIP1967,
  ZEPPELINOS,
} from "./lib.js";

test("to18 scales decimals to a common 18-dp fixed point", () => {
  assert.equal(to18(1_000_000n, 6), 10n ** 18n); // 1 USDC (6dp) -> 1e18
  assert.equal(to18(5n * 10n ** 18n, 18), 5n * 10n ** 18n); // 18dp unchanged
  assert.equal(to18(1n, 0), 10n ** 18n); // 0dp
  assert.equal(to18(10n ** 21n, 21), 10n ** 18n); // >18dp scales down
});

test("backingPct: locked vs minted ratio", () => {
  const one = 10n ** 18n;
  assert.equal(backingPct(one, one), 100); // exactly backed
  assert.equal(backingPct(one / 2n, one), 50); // half backed
  assert.equal(backingPct(2n * one, one), 200); // overbacked
  assert.equal(backingPct(one, 0n), null); // nothing minted -> no exposure
});

test("isUnderBacked: threshold comparisons", () => {
  const one = 10n ** 18n;
  assert.equal(isUnderBacked(one, one, 100), false); // exactly 100% is not under
  assert.equal(isUnderBacked(one - 1n, one, 100), true); // a wei short -> under
  assert.equal(isUnderBacked(one, 0n, 100), false); // no supply -> never under
  assert.equal(isUnderBacked(2n * one, one, 100), false); // overbacked
  // fractional threshold (99.5%): 99% backing breaches, 100% does not
  assert.equal(isUnderBacked(99n * one, 100n * one, 99.5), true);
  assert.equal(isUnderBacked(100n * one, 100n * one, 99.5), false);
});

test("firstBreachBlock pins the exact boundary in ~log2 probes", async () => {
  for (const B of [1, 2, 5, 100, 999, 1_000_000, 25_342_801]) {
    const { lastHealthy, firstBroken, probes } = await firstBreachBlock(
      0,
      25_342_815,
      async (n) => n >= B,
    );
    assert.equal(firstBroken, B, `firstBroken for B=${B}`);
    assert.equal(lastHealthy, B - 1, `lastHealthy for B=${B}`);
    assert.ok(probes <= 26, `probes ${probes} should be ~log2(range)`);
  }
});

test("addressFromSlot extracts the low 20 bytes; zero -> null", () => {
  const padded = "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  assert.equal(addressFromSlot(padded), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(addressFromSlot("0x" + "0".repeat(64)), null);
});

test("bytes32ToAddress: low 20 bytes, keeps zero (for native detection)", () => {
  const padded = "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  assert.equal(bytes32ToAddress(padded), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(bytes32ToAddress("0x" + "0".repeat(64)), "0x0000000000000000000000000000000000000000");
});

test("proxy slot constants are the known canonical values", () => {
  // EIP-1967: keccak256('eip1967.proxy.implementation') - 1 (fixed by the standard)
  assert.equal(EIP1967.implementation, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  assert.equal(EIP1967.admin, "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103");
  // Legacy zeppelinos slot must equal the plain keccak256 of its label
  assert.equal(ZEPPELINOS.implementation, keccak256(toUtf8Bytes("org.zeppelinos.proxy.implementation")));
  assert.notEqual(ZEPPELINOS.implementation, EIP1967.implementation);
});
