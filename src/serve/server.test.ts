import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:http";
import { Snapshot } from "./monitor.js";
import { createServer, parseWatchInput } from "./server.js";
import { Observation, Store } from "./storage.js";

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);
const ADDR_C = "0x" + "c".repeat(40);

function snapshot(): Snapshot {
  return {
    generatedAt: "2026-07-01T00:00:00.000Z",
    overall: "backed",
    backed: 1,
    breached: 0,
    errored: 0,
    total: 1,
    totalLockedUsd: 123,
    routes: [],
  };
}

function seededStore(): Store {
  const store = new Store(mkdtempSync(join(tmpdir(), "evmsec-serve-api-")));
  const obs: Observation = {
    id: "r1",
    bridge: "Test",
    asset: "TOK",
    lockChain: "Ethereum",
    mintChain: "Polygon PoS",
    locked: "100",
    minted: "99",
    ratioPct: 100.1,
    delta: "+1",
    verdict: "BACKED",
    at: "2026-07-01T00:00:00.000Z",
  };
  store.appendObservation(obs);
  store.appendAlert({ ...obs, kind: "breach", ratioPct: 98 });
  return store;
}

function boot(token?: string): Promise<{ base: string; server: Server; sweeps: number[] }> {
  const sweeps: number[] = [];
  const { server } = createServer({
    store: seededStore(),
    snapshot,
    lastSweep: () => "2026-07-01T00:00:00.000Z",
    routes: () => [],
    sweepNow: () => sweeps.push(1),
    token,
    startedAt: Date.now(),
    exposure: () => Promise.resolve([]),
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ base: `http://127.0.0.1:${port}`, server, sweeps });
    });
  });
}

const opened: Server[] = [];
after(() => {
  for (const s of opened) s.close();
});

test("GET /api/health, /api/status, /api/alerts, /api/routes/:id/history, and the dashboard", async () => {
  const { base, server } = await boot();
  opened.push(server);

  const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; lastSweepAt: string };
  assert.equal(health.ok, true);
  assert.ok(health.lastSweepAt);

  const status = (await (await fetch(`${base}/api/status`)).json()) as Snapshot;
  assert.equal(status.overall, "backed");
  assert.equal(status.totalLockedUsd, 123);

  const alerts = (await (await fetch(`${base}/api/alerts`)).json()) as Array<{ kind: string }>;
  assert.equal(alerts[0].kind, "breach");

  const history = (await (await fetch(`${base}/api/routes/r1/history?limit=5`)).json()) as Array<{ id: string }>;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "r1");

  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /watchtower/);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
});

test("watch CRUD over HTTP: loopback writes allowed when no token is configured", async () => {
  const { base, server, sweeps } = await boot();
  opened.push(server);

  const create = await fetch(`${base}/api/watches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      asset: "USDC",
      lock: { chain: "ethereum", escrow: ADDR_A, token: ADDR_B },
      mint: { chain: "polygon", token: ADDR_C },
    }),
  });
  assert.equal(create.status, 201);
  const watch = (await create.json()) as { id: string; minRatioPct: number };
  assert.equal(watch.minRatioPct, 100);
  assert.equal(sweeps.length, 1, "a new watch kicks an immediate sweep");

  const list = (await (await fetch(`${base}/api/watches`)).json()) as Array<{ id: string }>;
  assert.equal(list.length, 1);

  const bad = await fetch(`${base}/api/watches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lock: { chain: "notachain", escrow: ADDR_A, token: ADDR_B }, mint: {} }),
  });
  assert.equal(bad.status, 400);

  const gone = await fetch(`${base}/api/watches/${watch.id}`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.equal(sweeps.length, 2, "removing a watch also kicks a sweep to rebuild the snapshot");
  const missing = await fetch(`${base}/api/watches/${watch.id}`, { method: "DELETE" });
  assert.equal(missing.status, 404);
});

test("with a token configured, writes require it — even from loopback; reads stay open", async () => {
  const { base, server } = await boot("s3cret");
  opened.push(server);

  const body = JSON.stringify({
    lock: { chain: "ethereum", escrow: ADDR_A, token: ADDR_B },
    mint: { chain: "polygon", token: ADDR_C },
  });

  const noToken = await fetch(`${base}/api/watches`, { method: "POST", body });
  assert.equal(noToken.status, 401);

  const wrong = await fetch(`${base}/api/watches`, {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body,
  });
  assert.equal(wrong.status, 401);

  const right = await fetch(`${base}/api/watches`, {
    method: "POST",
    headers: { authorization: "Bearer s3cret" },
    body,
  });
  assert.equal(right.status, 201);

  const reads = await fetch(`${base}/api/status`);
  assert.equal(reads.status, 200);
});

test("GET /api/exposure validates the address before doing any chain work", async () => {
  const { base, server } = await boot();
  opened.push(server);
  const bad = await fetch(`${base}/api/exposure?address=nonsense`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/api/exposure?address=${ADDR_A}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), []);
});

test("parseWatchInput: validation catalogue", () => {
  const good = parseWatchInput(
    JSON.stringify({
      bridge: "  My bridge  ",
      lock: [
        { chain: "ethereum", escrow: ADDR_A, token: ADDR_B },
        { chain: "ethereum", escrow: ADDR_B, token: ADDR_A },
      ],
      mint: { chain: "base", token: ADDR_C },
      minRatioPct: 99.5,
    }),
  );
  assert.equal(good.bridge, "My bridge");
  assert.equal(Array.isArray(good.lock), true, "multi-leg lock survives");
  assert.equal(good.minRatioPct, 99.5);

  assert.throws(() => parseWatchInput("not json"), /valid JSON/);
  assert.throws(() => parseWatchInput("{}"), /lock leg/);
  assert.throws(
    () =>
      parseWatchInput(
        JSON.stringify({
          lock: { chain: "mars", escrow: ADDR_A, token: ADDR_B },
          mint: { chain: "base", token: ADDR_C },
        }),
      ),
    /unknown chain/,
  );
  assert.throws(
    () =>
      parseWatchInput(
        JSON.stringify({
          lock: { chain: "ethereum", escrow: "0x123", token: ADDR_B },
          mint: { chain: "base", token: ADDR_C },
        }),
      ),
    /escrow/,
  );
  assert.throws(
    () =>
      parseWatchInput(
        JSON.stringify({
          lock: { chain: "ethereum", escrow: ADDR_A, token: ADDR_B },
          mint: { chain: "base", token: ADDR_C },
          minRatioPct: -5,
        }),
      ),
    /minRatioPct/,
  );
});
