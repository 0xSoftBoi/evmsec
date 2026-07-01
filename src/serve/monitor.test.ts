import { test } from "node:test";
import assert from "node:assert/strict";
import { SolvencyResult } from "../commands/solvency.js";
import { Monitor, MonitorStore, buildSnapshot } from "./monitor.js";
import { AlertEvent, Observation } from "./storage.js";

function result(
  id: string,
  ratio: number | null,
  verdict: SolvencyResult["verdict"],
  lockedUsd?: number,
): SolvencyResult {
  return {
    id,
    bridge: "Test",
    asset: "TOK",
    lockChain: "Ethereum",
    mintChain: "Polygon PoS",
    locked: "100",
    minted: "99",
    ratioPct: ratio,
    delta: "+1",
    verdict,
    ...(lockedUsd !== undefined ? { lockedUsd } : {}),
  };
}

class FakeStore implements MonitorStore {
  observations: Observation[] = [];
  alertLog: AlertEvent[] = [];
  seed: Observation[] = [];
  appendObservation(obs: Observation): void {
    this.observations.push(obs);
  }
  appendAlert(alert: AlertEvent): void {
    this.alertLog.push(alert);
  }
  latest(): Observation[] {
    const byId = new Map<string, Observation>();
    for (const o of [...this.seed, ...this.observations]) byId.set(o.id, o);
    return [...byId.values()];
  }
  spark(): Array<number | null> {
    return [];
  }
}

function monitorWith(
  store: FakeStore,
  sweeps: SolvencyResult[][],
  extras?: { webhookUrl?: string; fetchFn?: typeof fetch },
): { monitor: Monitor; events: Array<{ event: string; data: unknown }> } {
  const events: Array<{ event: string; data: unknown }> = [];
  let i = 0;
  const monitor = new Monitor({
    routes: () => [],
    check: () => Promise.resolve(sweeps[Math.min(i++, sweeps.length - 1)]),
    store,
    broadcast: (event, data) => events.push({ event, data }),
    intervalMs: 60_000,
    minRatioFor: () => 100,
    ...extras,
  });
  return { monitor, events };
}

test("breach alerts once per transition; steady state stays quiet; recovery reports once", async () => {
  const store = new FakeStore();
  const breach = [result("r1", 98.5, "UNDERCOLLATERALIZED")];
  const healthy = [result("r1", 100.4, "BACKED")];
  const { monitor, events } = monitorWith(store, [breach, breach, healthy]);

  await monitor.sweep(); // first sighting already failing → breach
  await monitor.sweep(); // still failing → no new alert
  await monitor.sweep(); // healed → recovery

  assert.deepEqual(
    store.alertLog.map((a) => a.kind),
    ["breach", "recovery"],
  );
  assert.equal(store.observations.length, 3);
  const alertEvents = events.filter((e) => e.event === "alert");
  assert.equal(alertEvents.length, 2);
  const statusEvents = events.filter((e) => e.event === "status");
  assert.equal(statusEvents.length, 3, "a status snapshot broadcasts after every sweep");
});

test("restart does not re-alert a breach that was already known (state seeded from storage)", async () => {
  const store = new FakeStore();
  store.seed = [{ ...result("r1", 98.5, "UNDERCOLLATERALIZED"), at: "2026-01-01T00:00:00Z" }];
  const { monitor } = monitorWith(store, [[result("r1", 98.4, "UNDERCOLLATERALIZED")]]);
  await monitor.sweep();
  assert.equal(store.alertLog.length, 0, "known breach must not page again after a restart");
});

test("webhook posts the --watch-compatible schema on each transition", async () => {
  const posts: Array<{ url: string; body: string }> = [];
  const fetchFn = ((url: string, init?: { body?: string }) => {
    posts.push({ url, body: init?.body ?? "" });
    return Promise.resolve(new Response("ok"));
  }) as unknown as typeof fetch;

  const store = new FakeStore();
  const { monitor } = monitorWith(store, [[result("r1", 97, "UNDERCOLLATERALIZED")]], {
    webhookUrl: "https://hooks.example/x",
    fetchFn,
  });
  await monitor.sweep();

  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].body) as { event: string; kind: string; id: string; ratioPct: number };
  assert.equal(body.event, "breach");
  assert.equal(body.id, "r1");
  assert.equal(body.ratioPct, 97);
});

test("a webhook failure is logged, never fatal to the sweep", async () => {
  const fetchFn = (() => Promise.reject(new Error("sink down"))) as unknown as typeof fetch;
  const store = new FakeStore();
  const logs: string[] = [];
  const monitor = new Monitor({
    routes: () => [],
    check: () => Promise.resolve([result("r1", 97, "UNDERCOLLATERALIZED")]),
    store,
    broadcast: () => {},
    intervalMs: 60_000,
    minRatioFor: () => 100,
    webhookUrl: "https://hooks.example/x",
    fetchFn,
    log: (m) => logs.push(m),
  });
  const snap = await monitor.sweep();
  assert.ok(snap, "sweep completes despite the webhook failure");
  assert.ok(logs.some((l) => l.includes("webhook POST failed")));
  assert.equal(store.alertLog.length, 1, "the alert is still recorded locally");
});

test("a sweep requested mid-sweep is queued, not dropped (watch added during a slow sweep)", async () => {
  const store = new FakeStore();
  let checks = 0;
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  const monitor = new Monitor({
    routes: () => [],
    check: async () => {
      checks++;
      if (checks === 1) await gate; // first sweep is slow
      return [result("r1", 100.5, "BACKED")];
    },
    store,
    broadcast: () => {},
    intervalMs: 60_000,
    minRatioFor: () => 100,
  });

  const first = monitor.sweep(); // in flight
  const second = monitor.sweep(); // arrives mid-sweep → must queue a rerun
  releaseFirst?.();
  await Promise.all([first, second]);
  await new Promise((r) => setTimeout(r, 10)); // let the queued rerun land

  assert.equal(checks, 2, "the mid-sweep request ran after the first sweep finished");
});

test("buildSnapshot rolls up counts, overall, and USD like STATUS.json", () => {
  const at = "2026-07-01T00:00:00Z";
  const latest: Observation[] = [
    { ...result("a", 100.2, "BACKED", 1_000_000), at },
    { ...result("b", 99.1, "UNDERCOLLATERALIZED", 2_000_000), at },
    { ...result("c", null, "ERROR"), at },
  ];
  const snap = buildSnapshot(latest, () => [100, 99]);
  assert.equal(snap.overall, "undercollateralized");
  assert.equal(snap.backed, 1);
  assert.equal(snap.breached, 1);
  assert.equal(snap.errored, 1);
  assert.equal(snap.total, 3);
  assert.equal(snap.totalLockedUsd, 3_000_000);
  assert.deepEqual(snap.routes[0].spark, [100, 99]);

  const degraded = buildSnapshot([{ ...result("c", null, "ERROR"), at }], () => []);
  assert.equal(degraded.overall, "degraded");
  assert.equal(degraded.totalLockedUsd, null);

  const green = buildSnapshot([{ ...result("a", 100.2, "BACKED", 5), at }], () => []);
  assert.equal(green.overall, "backed");
});

test("min-ratio below 100 tolerates a mild deficit; per-route thresholds apply", async () => {
  const store = new FakeStore();
  const monitor = new Monitor({
    routes: () => [],
    check: () => Promise.resolve([result("lenient", 99.5, "UNDERCOLLATERALIZED")]),
    store,
    broadcast: () => {},
    intervalMs: 60_000,
    minRatioFor: (id) => (id === "lenient" ? 99 : 100),
  });
  await monitor.sweep();
  // verdict is UNDERCOLLATERALIZED (a hard verdict always fails) — this documents
  // that the verdict, not just the ratio, drives failing; the threshold only
  // matters for BACKED routes that drift below a stricter bar.
  assert.equal(store.alertLog.length, 1);

  const store2 = new FakeStore();
  const monitor2 = new Monitor({
    routes: () => [],
    check: () => Promise.resolve([result("strict", 100.5, "BACKED")]),
    store: store2,
    broadcast: () => {},
    intervalMs: 60_000,
    minRatioFor: () => 101, // stricter than the live ratio
  });
  await monitor2.sweep();
  assert.equal(store2.alertLog.length, 1, "a BACKED route below a stricter min-ratio still alerts");
});
