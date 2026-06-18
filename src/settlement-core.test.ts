import { test } from "node:test";
import assert from "node:assert/strict";
import { matchDelivery, classify, isNativeToken, ExpectedOutput, ObservedTransfer } from "./settlement-core.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000B0";

function output(over: Partial<ExpectedOutput> = {}): ExpectedOutput {
  return { token: USDC, amount: 1_000_000n, recipient: ALICE, chainId: 8453, native: false, ...over };
}

test("isNativeToken: only the zero address is native", () => {
  assert.equal(isNativeToken("0x0000000000000000000000000000000000000000"), true);
  assert.equal(isNativeToken(USDC), false);
});

test("matchDelivery: happy path — exact token/recipient/amount", () => {
  const transfers: ObservedTransfer[] = [{ token: USDC, to: ALICE, value: 1_000_000n }];
  const c = matchDelivery(output(), transfers);
  assert.equal(c.matched, true);
  assert.equal(c.amountSufficient, true);
  assert.equal(c.deliveredValue, 1_000_000n);
});

test("matchDelivery: sums multiple transfers of the right token to recipient", () => {
  const transfers: ObservedTransfer[] = [
    { token: USDC, to: ALICE, value: 400_000n },
    { token: USDC, to: ALICE, value: 600_000n },
  ];
  const c = matchDelivery(output(), transfers);
  assert.equal(c.deliveredValue, 1_000_000n);
  assert.equal(c.amountSufficient, true);
});

test("matchDelivery: wrong recipient — not matched, recipient not reached", () => {
  const transfers: ObservedTransfer[] = [{ token: USDC, to: BOB, value: 1_000_000n }];
  const c = matchDelivery(output(), transfers);
  assert.equal(c.matched, false);
  assert.equal(c.recipientReached, false);
});

test("matchDelivery: right recipient but wrong token", () => {
  const transfers: ObservedTransfer[] = [{ token: DAI, to: ALICE, value: 1_000_000n }];
  const c = matchDelivery(output(), transfers);
  assert.equal(c.matched, false);
  assert.equal(c.recipientReached, true);
  assert.equal(c.tokenCorrect, false);
});

test("matchDelivery: underfill", () => {
  const transfers: ObservedTransfer[] = [{ token: USDC, to: ALICE, value: 900_000n }];
  const c = matchDelivery(output(), transfers);
  assert.equal(c.matched, true);
  assert.equal(c.amountSufficient, false);
});

test("classify: settled when matched, on time, final", () => {
  const c = matchDelivery(output(), [{ token: USDC, to: ALICE, value: 1_000_000n }]);
  const v = classify(c, { deadlineMet: true, finalized: true, expectedAmount: 1_000_000n });
  assert.equal(v.status, "settled");
  assert.equal(v.anomalies.length, 0);
});

test("classify: unsettled when nothing delivered", () => {
  const c = matchDelivery(output(), [{ token: USDC, to: BOB, value: 1_000_000n }]);
  const v = classify(c, { deadlineMet: true, finalized: true, expectedAmount: 1_000_000n });
  assert.equal(v.status, "unsettled");
  assert.ok(v.anomalies.length > 0);
});

test("classify: anomaly when filled after deadline", () => {
  const c = matchDelivery(output(), [{ token: USDC, to: ALICE, value: 1_000_000n }]);
  const v = classify(c, { deadlineMet: false, finalized: true, expectedAmount: 1_000_000n });
  assert.equal(v.status, "anomaly");
  assert.ok(v.anomalies.some((a) => a.includes("fillDeadline")));
});

test("classify: under-ceiling delivery is a warning, not an anomaly", () => {
  const c = matchDelivery(output(), [{ token: USDC, to: ALICE, value: 900_000n }]);
  const v = classify(c, { deadlineMet: true, finalized: true, expectedAmount: 1_000_000n });
  assert.equal(v.status, "settled");
  assert.ok(v.warnings.some((w) => w.includes("maxSpent")));
});

test("classify: non-final fill flagged as a warning", () => {
  const c = matchDelivery(output(), [{ token: USDC, to: ALICE, value: 1_000_000n }]);
  const v = classify(c, { deadlineMet: true, finalized: false, expectedAmount: 1_000_000n });
  assert.equal(v.status, "settled");
  assert.ok(v.warnings.some((w) => w.includes("finality")));
});
