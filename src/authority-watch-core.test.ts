import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthoritySnapshot,
  BaselineFile,
  Drift,
  computeAuthorityTransitions,
  delegationTarget,
  diffBaselines,
  diffSnapshots,
  mergeSnapshots,
  parseBaselineFile,
  renderAuthorityHuman,
  renderAuthorityJson,
  snapshotKey,
} from "./authority-watch-core.js";

const SAFE_A: AuthoritySnapshot = {
  address: "0x1111111111111111111111111111111111111111",
  chain: "ethereum",
  label: "bridge multisig",
  capturedAt: "2026-10-04T00:00:00.000Z",
  kind: "safe",
  codehash: "0xabc",
  owners: ["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
  threshold: 2,
  modules: [],
};

const snap = (overrides: Partial<AuthoritySnapshot>): AuthoritySnapshot => ({ ...SAFE_A, ...overrides });

test("snapshotKey: chain + lowercased address", () => {
  assert.equal(snapshotKey(SAFE_A), "ethereum:0x1111111111111111111111111111111111111111");
  assert.equal(
    snapshotKey({ ...SAFE_A, address: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x") }),
    "ethereum:0x1111111111111111111111111111111111111111",
  );
});

test("delegationTarget: parses 7702 code, rejects the rest", () => {
  assert.equal(
    delegationTarget("0xef0100" + "63c0c19a282a1B52b07dD5a65b58948A07DAE32B"),
    "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b",
  );
  assert.equal(delegationTarget("0x"), null);
  assert.equal(delegationTarget("0xef0100"), null); // truncated
  assert.equal(delegationTarget("0x6080604052348015600f57600080fd5b50"), null);
});

test("diffSnapshots: identical snapshots produce no drift", () => {
  assert.deepEqual(diffSnapshots(SAFE_A, snap({})), []);
});

test("diffSnapshots: owner added / removed / threshold / module changes all fire", () => {
  const added = diffSnapshots(
    SAFE_A,
    snap({ owners: [...SAFE_A.owners!, "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"] }),
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].field, "owners");

  const removed = diffSnapshots(SAFE_A, snap({ owners: [SAFE_A.owners![0]] }));
  assert.equal(removed.length, 1);

  const threshold = diffSnapshots(SAFE_A, snap({ threshold: 1 }));
  assert.deepEqual(
    threshold.map((d) => d.field),
    ["threshold"],
  );
  assert.equal(threshold[0].before, "2");
  assert.equal(threshold[0].after, "1");

  const moduleAdded = diffSnapshots(SAFE_A, snap({ modules: ["0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"] }));
  assert.equal(moduleAdded[0].field, "modules");
});

test("diffSnapshots: kind, codehash, delegation, and delay changes fire", () => {
  assert.equal(diffSnapshots(SAFE_A, snap({ kind: "eoa" }))[0].field, "kind");
  assert.equal(diffSnapshots(SAFE_A, snap({ codehash: "0xdef" }))[0].field, "codehash");

  const eoa = snap({
    kind: "eoa",
    codehash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    owners: undefined,
    threshold: undefined,
    modules: undefined,
    delegation: null,
  });
  const delegated = diffSnapshots(eoa, { ...eoa, delegation: "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b" });
  assert.equal(delegated[0].field, "delegation");

  const tl = snap({
    kind: "timelock",
    minDelaySec: 172800,
    owners: undefined,
    threshold: undefined,
    modules: undefined,
  });
  const tlChanged = diffSnapshots(tl, { ...tl, minDelaySec: 0 });
  assert.equal(tlChanged[0].field, "minDelaySec");
});

test("diffBaselines: matches by key, flags missing captures", () => {
  const baseline: BaselineFile = { version: 1, snapshots: [SAFE_A] };
  assert.deepEqual(diffBaselines(baseline, [snap({})]), []);
  const missing = diffBaselines(baseline, []);
  assert.equal(missing[0].field, "presence");
});

test("computeAuthorityTransitions: drift alerts once, recovery alerts once", () => {
  const key = snapshotKey(SAFE_A);
  const drift: Drift[] = [
    { address: SAFE_A.address, chain: "ethereum", label: "x", field: "threshold", before: "2", after: "1" },
  ];
  const drifted = new Map<string, Drift[]>([[key, drift]]);
  const clean = new Map<string, Drift[]>();
  const wasDrifted = new Map<string, boolean>([[key, true]]);

  // new drift → alert
  let t = computeAuthorityTransitions(new Map<string, boolean>(), drifted);
  assert.deepEqual(
    t.map((x) => x.kind),
    ["drift"],
  );

  // persisting drift → silent
  t = computeAuthorityTransitions(wasDrifted, drifted);
  assert.deepEqual(t, []);

  // resolved → recovery
  t = computeAuthorityTransitions(wasDrifted, clean);
  assert.deepEqual(
    t.map((x) => x.kind),
    ["recovered"],
  );

  // never drifted, clean → silent
  t = computeAuthorityTransitions(new Map<string, boolean>(), clean);
  assert.deepEqual(t, []);
});

test("parseBaselineFile: validates shape with helpful errors", () => {
  const good = parseBaselineFile(JSON.stringify({ version: 1, snapshots: [SAFE_A] }), "f.json");
  assert.equal(good.snapshots.length, 1);
  assert.throws(() => parseBaselineFile("not json", "f.json"), /not valid JSON/);
  assert.throws(() => parseBaselineFile(JSON.stringify({ version: 2, snapshots: [] }), "f.json"), /expected/);
  assert.throws(
    () => parseBaselineFile(JSON.stringify({ version: 1, snapshots: [{ address: "0x1" }] }), "f.json"),
    /missing address\/chain\/kind\/codehash/,
  );
});

test("mergeSnapshots: incoming wins on key collision, keeps the rest", () => {
  const merged = mergeSnapshots({ version: 1, snapshots: [SAFE_A] }, [
    snap({ threshold: 3 }),
    snap({ address: "0x2222222222222222222222222222222222222222", label: "other" }),
  ]);
  assert.equal(merged.snapshots.length, 2);
  assert.equal(merged.snapshots.find((s) => s.address === SAFE_A.address)!.threshold, 3);
});

test("renderAuthorityHuman/Json: drifted and clean states", () => {
  const baseline: BaselineFile = { version: 1, snapshots: [SAFE_A] };
  const clean = renderAuthorityHuman(baseline, []);
  assert.match(clean, /no drift/);
  assert.match(clean, /no authority drift/);

  const drifted = renderAuthorityHuman(baseline, [
    { address: SAFE_A.address, chain: "ethereum", label: SAFE_A.label, field: "threshold", before: "2", after: "1" },
  ]);
  assert.match(drifted, /DRIFT/);
  assert.match(drifted, /threshold/);

  const j = JSON.parse(renderAuthorityJson(baseline, []));
  assert.equal(j.ok, true);
  assert.equal(j.overall, "ok");
  const j2 = JSON.parse(
    renderAuthorityJson(baseline, [
      { address: SAFE_A.address, chain: "ethereum", label: "x", field: "owners", before: "a", after: "b" },
    ]),
  );
  assert.equal(j2.ok, false);
  assert.equal(j2.overall, "drift");
});
