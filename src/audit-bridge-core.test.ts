import { test } from "node:test";
import assert from "node:assert/strict";
import { planTargets, renderBridgeHuman, renderBridgeJson, solvencyToReport } from "./audit-bridge-core.js";
import type { SolvencyResult } from "./commands/solvency.js";
import type { Route } from "./bridges.js";

const singleLeg: Route = {
  id: "polygon-pos-usdc",
  bridge: "Polygon PoS",
  asset: "USDC.e",
  lock: {
    chain: "ethereum",
    escrow: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  mint: { chain: "polygon", token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
};

const multiLeg: Route = {
  id: "multi-test",
  bridge: "Test Bridge",
  asset: "TEST",
  lock: [
    {
      chain: "ethereum",
      escrow: "0x0000000000000000000000000000000000000001",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    {
      chain: "arbitrum",
      escrow: "0x0000000000000000000000000000000000000002",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
  ],
  mint: { chain: "base", token: "0x0000000000000000000000000000000000000003" },
};

function solvencyResult(overrides: Partial<SolvencyResult>): SolvencyResult {
  return {
    id: "polygon-pos-usdc",
    bridge: "Polygon PoS",
    asset: "USDC.e",
    lockChain: "Ethereum",
    mintChain: "Polygon",
    locked: "1000",
    minted: "990",
    ratioPct: 101.01,
    delta: "+10",
    verdict: "BACKED",
    ...overrides,
  };
}

test("planTargets: single-leg route yields escrow + wrapped token in report order", () => {
  const targets = planTargets(singleLeg);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].kind, "escrow");
  assert.equal(targets[0].chain.key, "ethereum");
  assert.equal(targets[0].address, "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf");
  assert.equal(targets[1].kind, "wrapped-token");
  assert.equal(targets[1].chain.key, "polygon");
  assert.equal(targets[1].address, "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
});

test("planTargets: multi-leg route yields one escrow per leg", () => {
  const targets = planTargets(multiLeg);
  assert.equal(targets.length, 3);
  assert.deepEqual(
    targets.map((t) => t.kind),
    ["escrow", "escrow", "wrapped-token"],
  );
  assert.deepEqual(
    targets.map((t) => t.chain.key),
    ["ethereum", "arbitrum", "base"],
  );
});

test("solvencyToReport: BACKED maps to ok", () => {
  const r = solvencyToReport(solvencyResult({ verdict: "BACKED", ratioPct: 101.01 }));
  assert.equal(r.id, "solvency");
  assert.equal(r.severity, "ok");
  assert.match(r.summary, /101\.01/);
});

test("solvencyToReport: UNDERCOLLATERALIZED maps to critical with the shortfall", () => {
  const r = solvencyToReport(solvencyResult({ verdict: "UNDERCOLLATERALIZED", ratioPct: 80, delta: "-200" }));
  assert.equal(r.severity, "critical");
  assert.match(r.summary, /UNDERBACKED/);
  assert.equal(r.evidence.shortfall, "-200");
});

test("solvencyToReport: NO_SUPPLY maps to warning, ERROR maps to skip", () => {
  assert.equal(solvencyToReport(solvencyResult({ verdict: "NO_SUPPLY", ratioPct: null })).severity, "warning");
  const err = solvencyToReport(solvencyResult({ verdict: "ERROR", ratioPct: null, error: "rpc down" }));
  assert.equal(err.severity, "skip");
  assert.match(err.summary, /rpc down/);
});

test("renderBridgeHuman: sections, report card, and overall verdict", () => {
  const solvency = solvencyToReport(solvencyResult({ verdict: "BACKED" }));
  const out = renderBridgeHuman(
    singleLeg,
    solvency,
    { key: "polygon", name: "Polygon", chainId: 137, rpcUrl: "", explorer: "", symbol: "MATIC" },
    [
      {
        target: planTargets(singleLeg)[0],
        reports: [
          {
            id: "admin-power",
            title: "Admin power",
            severity: "warning",
            summary: "timelock with short delay",
            evidence: {},
            notes: [],
          },
        ],
      },
    ],
    "critical",
  );
  assert.match(out, /evmsec audit-bridge — polygon-pos-usdc/);
  assert.match(out, /Bridge solvency/);
  assert.match(out, /Escrow \(ethereum\)/);
  assert.match(out, /OVERALL: ⚠ no critical findings/);
  assert.match(out, /Report card/);
});

test("renderBridgeJson: shape, counts, and fail-on gating", () => {
  const solvency = solvencyToReport(solvencyResult({ verdict: "UNDERCOLLATERALIZED", ratioPct: 80 }));
  const json = renderBridgeJson(
    singleLeg,
    solvency,
    solvencyResult({ verdict: "UNDERCOLLATERALIZED" }),
    [],
    "critical",
  );
  const parsed = JSON.parse(json);
  assert.equal(parsed.tool, "evmsec");
  assert.equal(parsed.command, "audit-bridge");
  assert.equal(parsed.route.id, "polygon-pos-usdc");
  assert.equal(parsed.overall, "critical");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.targets.length, 0);

  const okJson = JSON.parse(
    renderBridgeJson(
      singleLeg,
      solvencyToReport(solvencyResult({ verdict: "BACKED" })),
      solvencyResult({}),
      [],
      "critical",
    ),
  );
  assert.equal(okJson.overall, "ok");
  assert.equal(okJson.ok, true);
});
