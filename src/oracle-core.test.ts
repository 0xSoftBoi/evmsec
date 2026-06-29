import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOracle } from "./oracle-core.js";

const NOW = 1_700_000_000;
const HEARTBEAT = 3600; // 1h

test("classifyOracle: fresh, positive answer → info, no fail", () => {
  const v = classifyOracle({
    round: { answer: 200000000000n, updatedAt: NOW - 60 },
    now: NOW,
    heartbeatSec: HEARTBEAT,
  });
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
  assert.equal(v.stale, false);
});

test("classifyOracle: answer past the heartbeat → stale, critical, fails CI", () => {
  const v = classifyOracle({
    round: { answer: 200000000000n, updatedAt: NOW - 2 * HEARTBEAT },
    now: NOW,
    heartbeatSec: HEARTBEAT,
  });
  assert.equal(v.stale, true);
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
});

test("classifyOracle: zero/negative answer → critical, fails CI", () => {
  const zero = classifyOracle({ round: { answer: 0n, updatedAt: NOW - 10 }, now: NOW, heartbeatSec: HEARTBEAT });
  assert.equal(zero.nonPositive, true);
  assert.equal(zero.fail, true);
  const neg = classifyOracle({ round: { answer: -5n, updatedAt: NOW - 10 }, now: NOW, heartbeatSec: HEARTBEAT });
  assert.equal(neg.risk, "critical");
  assert.equal(neg.fail, true);
});

test("classifyOracle: updatedAt == 0 → incomplete round, critical", () => {
  const v = classifyOracle({ round: { answer: 100n, updatedAt: 0 }, now: NOW, heartbeatSec: HEARTBEAT });
  assert.equal(v.fail, true);
  assert.ok(v.summary.includes("incomplete") || v.summary.includes("updatedAt"));
});

test("classifyOracle: answeredInRound < roundId → stale round, elevated (no CI fail)", () => {
  const v = classifyOracle({
    round: { answer: 100n, updatedAt: NOW - 60, roundId: 100n, answeredInRound: 98n },
    now: NOW,
    heartbeatSec: HEARTBEAT,
  });
  assert.equal(v.staleRound, true);
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
});

test("classifyOracle: L2 sequencer down → critical, fails CI (overrides a fresh price)", () => {
  const v = classifyOracle({
    round: { answer: 200000000000n, updatedAt: NOW - 10 },
    now: NOW,
    heartbeatSec: HEARTBEAT,
    sequencer: { up: false, since: NOW - 30 },
  });
  assert.equal(v.risk, "critical");
  assert.equal(v.fail, true);
  assert.ok(v.summary.toLowerCase().includes("sequencer"));
});

test("classifyOracle: sequencer just restarted within grace → elevated, no fail", () => {
  const v = classifyOracle({
    round: { answer: 200000000000n, updatedAt: NOW - 10 },
    now: NOW,
    heartbeatSec: HEARTBEAT,
    sequencer: { up: true, since: NOW - 120 },
    sequencerGraceSec: 3600,
  });
  assert.equal(v.risk, "elevated");
  assert.equal(v.fail, false);
});

test("classifyOracle: sequencer up well past grace → falls through to freshness (info)", () => {
  const v = classifyOracle({
    round: { answer: 200000000000n, updatedAt: NOW - 10 },
    now: NOW,
    heartbeatSec: HEARTBEAT,
    sequencer: { up: true, since: NOW - 10 * 3600 },
    sequencerGraceSec: 3600,
  });
  assert.equal(v.risk, "info");
  assert.equal(v.fail, false);
});

test("classifyOracle: sequencer down takes precedence over a stale price", () => {
  const v = classifyOracle({
    round: { answer: 200000000000n, updatedAt: NOW - 5 * HEARTBEAT },
    now: NOW,
    heartbeatSec: HEARTBEAT,
    sequencer: { up: false, since: NOW - 30 },
  });
  assert.equal(v.fail, true);
  assert.ok(v.summary.toLowerCase().includes("sequencer"));
});
