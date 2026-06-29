import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFillTx, chunkRange, FillCandidate } from "./discovery-core.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000B0";

const expected = { token: USDC, recipient: ALICE, amount: 1_000_000n };

test("selectFillTx: picks the tx that satisfies the expected output", () => {
  const cands: FillCandidate[] = [
    { tx: "0xfill", block: 100, token: USDC, to: ALICE, value: 1_000_000n },
    { tx: "0xother", block: 90, token: DAI, to: ALICE, value: 9n },
  ];
  const m = selectFillTx(expected, cands);
  assert.equal(m?.tx, "0xfill");
  assert.equal(m?.deliveredValue, 1_000_000n);
});

test("selectFillTx: sums multiple transfers in one tx", () => {
  const cands: FillCandidate[] = [
    { tx: "0xfill", block: 100, token: USDC, to: ALICE, value: 400_000n },
    { tx: "0xfill", block: 100, token: USDC, to: ALICE, value: 600_000n },
  ];
  assert.equal(selectFillTx(expected, cands)?.deliveredValue, 1_000_000n);
});

test("selectFillTx: ignores wrong token / wrong recipient", () => {
  const cands: FillCandidate[] = [
    { tx: "0xwrongtoken", block: 100, token: DAI, to: ALICE, value: 1_000_000n },
    { tx: "0xwrongto", block: 100, token: USDC, to: BOB, value: 1_000_000n },
  ];
  assert.equal(selectFillTx(expected, cands), null);
});

test("selectFillTx: returns the earliest satisfying tx", () => {
  const cands: FillCandidate[] = [
    { tx: "0xlate", block: 200, token: USDC, to: ALICE, value: 1_000_000n },
    { tx: "0xearly", block: 150, token: USDC, to: ALICE, value: 1_000_000n },
  ];
  assert.equal(selectFillTx(expected, cands)?.tx, "0xearly");
});

test("selectFillTx: underfilled candidates do not match", () => {
  const cands: FillCandidate[] = [{ tx: "0xshort", block: 100, token: USDC, to: ALICE, value: 999_999n }];
  assert.equal(selectFillTx(expected, cands), null);
});

test("chunkRange: splits into ascending sub-ranges", () => {
  assert.deepEqual(chunkRange(0, 25, 10), [
    [0, 9],
    [10, 19],
    [20, 25],
  ]);
});

test("chunkRange: a range smaller than the step is one chunk", () => {
  assert.deepEqual(chunkRange(100, 105, 1000), [[100, 105]]);
});

test("chunkRange: normalizes reversed / negative inputs", () => {
  assert.deepEqual(chunkRange(30, 10, 10), [
    [10, 19],
    [20, 29],
    [30, 30],
  ]);
  assert.deepEqual(chunkRange(-5, 5, 10), [[0, 5]]);
});
