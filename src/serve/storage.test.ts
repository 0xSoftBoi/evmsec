import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Observation, watchToRoute } from "./storage.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "evmsec-serve-"));
}

function obs(id: string, ratio: number | null, verdict: Observation["verdict"] = "BACKED"): Observation {
  return {
    id,
    bridge: "Test Bridge",
    asset: "TOK",
    lockChain: "Ethereum",
    mintChain: "Polygon PoS",
    locked: "100",
    minted: "99",
    ratioPct: ratio,
    delta: "+1",
    verdict,
    at: new Date().toISOString(),
  };
}

test("observations: append, latest per route, history newest-first, spark oldest-first", () => {
  const store = new Store(tmp());
  store.appendObservation(obs("route-a", 101));
  store.appendObservation(obs("route-a", 99, "UNDERCOLLATERALIZED"));
  store.appendObservation(obs("route-b", 100));

  const latest = store.latest();
  assert.equal(latest.length, 2);
  assert.equal(latest[0].id, "route-a"); // sorted by id
  assert.equal(latest[0].ratioPct, 99); // newest wins
  assert.equal(latest[0].verdict, "UNDERCOLLATERALIZED");

  const hist = store.history("route-a", 10);
  assert.deepEqual(
    hist.map((o) => o.ratioPct),
    [99, 101],
  );
  assert.deepEqual(store.spark("route-a"), [101, 99]);
  assert.deepEqual(store.history("nope"), []);
});

test("observations survive a restart (new Store over the same dir)", () => {
  const dir = tmp();
  const first = new Store(dir);
  first.appendObservation(obs("route-a", 100.5));
  first.appendObservation(obs("route-a", 100.7));

  const second = new Store(dir);
  assert.equal(second.latest().length, 1);
  assert.equal(second.latest()[0].ratioPct, 100.7);
  assert.equal(second.history("route-a").length, 2);
});

test("unsafe route ids are encoded on disk, transparent in the API", () => {
  const dir = tmp();
  const store = new Store(dir);
  store.appendObservation(obs("weird/../id with spaces", 100));
  assert.equal(store.latest()[0].id, "weird/../id with spaces");
  assert.ok(!existsSync(join(dir, "observations", "weird")), "no path traversal on disk");
  // survives reload through the encoded filename
  const again = new Store(dir);
  assert.equal(again.latest()[0].id, "weird/../id with spaces");
});

test("alerts: append + newest-first + persistence + torn-line tolerance", () => {
  const dir = tmp();
  const store = new Store(dir);
  store.appendAlert({ ...obs("route-a", 99, "UNDERCOLLATERALIZED"), kind: "breach" });
  store.appendAlert({ ...obs("route-a", 101), kind: "recovery" });
  assert.deepEqual(
    store.alerts().map((a) => a.kind),
    ["recovery", "breach"],
  );
  // a torn trailing line (crash mid-append) must not poison the reload
  const path = join(dir, "alerts.jsonl");
  assert.ok(readFileSync(path, "utf8").endsWith("\n"));
  const reloaded = new Store(dir);
  assert.equal(reloaded.alerts().length, 2);
});

test("watches: add/list/remove, persisted, and convertible to engine routes", () => {
  const dir = tmp();
  const store = new Store(dir);
  const w = store.addWatch({
    bridge: "My bridge",
    asset: "USDC",
    lock: { chain: "ethereum", escrow: "0x" + "1".repeat(40), token: "0x" + "2".repeat(40) },
    mint: { chain: "polygon", token: "0x" + "3".repeat(40) },
    minRatioPct: 99.5,
  });
  assert.match(w.id, /^watch-/);
  assert.equal(store.watches().length, 1);

  const route = watchToRoute(w);
  assert.equal(route.id, w.id);
  assert.equal(route.mint.chain, "polygon");

  const reloaded = new Store(dir);
  assert.equal(reloaded.watches().length, 1);
  assert.equal(reloaded.watches()[0].minRatioPct, 99.5);

  assert.equal(reloaded.removeWatch(w.id), true);
  assert.equal(reloaded.removeWatch(w.id), false);
  assert.equal(new Store(dir).watches().length, 0);
});

test("removing a watch drops its observations — no ghost row, not even after restart", () => {
  const dir = tmp();
  const store = new Store(dir);
  const w = store.addWatch({
    bridge: "Ghost bridge",
    asset: "GHO",
    lock: { chain: "ethereum", escrow: "0x" + "1".repeat(40), token: "0x" + "2".repeat(40) },
    mint: { chain: "polygon", token: "0x" + "3".repeat(40) },
    minRatioPct: 100,
  });
  store.appendObservation(obs(w.id, 100.2));
  store.appendObservation(obs("registry-route", 100.5));
  assert.equal(store.latest().length, 2);

  store.removeWatch(w.id);
  assert.deepEqual(
    store.latest().map((o) => o.id),
    ["registry-route"],
    "the watch's row leaves the board immediately",
  );
  assert.deepEqual(
    new Store(dir).latest().map((o) => o.id),
    ["registry-route"],
    "…and does not resurrect from disk on restart",
  );
});
