import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "./diagnose-core.js";

const DEADLINE = 1_900_000_000;
const before = DEADLINE - 100;
const after = DEADLINE + 100;

test("diagnose: no deliveries → never-filled", () => {
  const d = diagnose({ amount: 1_000_000n, deadline: DEADLINE, toRecipient: [] });
  assert.equal(d.mode, "never-filled");
  assert.equal(d.deliveredValue, 0n);
});

test("diagnose: enough, on time → settled", () => {
  const d = diagnose({
    amount: 1_000_000n,
    deadline: DEADLINE,
    toRecipient: [{ value: 1_000_000n, ts: before, tx: "0xfill" }],
  });
  assert.equal(d.mode, "settled");
  assert.equal(d.tx, "0xfill");
});

test("diagnose: enough but after the deadline → filled-late", () => {
  const d = diagnose({
    amount: 1_000_000n,
    deadline: DEADLINE,
    toRecipient: [{ value: 1_000_000n, ts: after, tx: "0xlate" }],
  });
  assert.equal(d.mode, "filled-late");
  assert.equal(d.tx, "0xlate");
  assert.ok(d.evidence.some((e) => e.includes("late by")));
});

test("diagnose: partial delivery → underfilled", () => {
  const d = diagnose({
    amount: 1_000_000n,
    deadline: DEADLINE,
    toRecipient: [{ value: 600_000n, ts: before, tx: "0xpart" }],
  });
  assert.equal(d.mode, "underfilled");
  assert.equal(d.deliveredValue, 600_000n);
});

test("diagnose: multiple deliveries sum; completing tx is the one that crosses", () => {
  const d = diagnose({
    amount: 1_000_000n,
    deadline: DEADLINE,
    toRecipient: [
      { value: 400_000n, ts: before - 10, tx: "0xa" },
      { value: 600_000n, ts: before, tx: "0xb" },
      { value: 50_000n, ts: before + 5, tx: "0xc" },
    ],
  });
  assert.equal(d.mode, "settled");
  assert.equal(d.tx, "0xb"); // the one that reached 1_000_000
  assert.equal(d.deliveredValue, 1_050_000n);
});

test("diagnose: deadline 0 (none declared) is always on time", () => {
  const d = diagnose({
    amount: 1n,
    deadline: 0,
    toRecipient: [{ value: 1n, ts: after, tx: "0xx" }],
  });
  assert.equal(d.mode, "settled");
});
