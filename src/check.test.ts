import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckReport, renderJson, renderSarif, severityRank, worstSeverity } from "./check.js";

const CHAIN = { key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io" } as never;
const TARGET = "0x00000000000000000000000000000000000000A1";

function r(id: string, severity: CheckReport["severity"]): CheckReport {
  return { id, title: id, severity, summary: `${id} summary`, evidence: {}, notes: [] };
}

test("severityRank orders critical > warning > ok > skip", () => {
  assert.ok(severityRank("critical") > severityRank("warning"));
  assert.ok(severityRank("warning") > severityRank("ok"));
  assert.ok(severityRank("ok") > severityRank("skip"));
});

test("worstSeverity picks the highest-rank report", () => {
  assert.equal(worstSeverity([r("a", "ok"), r("b", "critical"), r("c", "warning")]), "critical");
  assert.equal(worstSeverity([r("a", "ok"), r("b", "warning")]), "warning");
  assert.equal(worstSeverity([]), "skip");
});

test("renderJson reports overall, counts, and ok against the fail threshold", () => {
  const out = JSON.parse(renderJson({ chain: CHAIN, target: TARGET }, [r("a", "warning"), r("b", "ok")], "critical"));
  assert.equal(out.overall, "warning");
  assert.equal(out.ok, true); // worst (warning) is below failOn (critical)
  assert.equal(out.counts.warning, 1);
  assert.equal(out.counts.ok, 1);
  assert.equal(out.reports.length, 2);
});

test("renderJson: ok=false when worst meets the fail threshold", () => {
  const out = JSON.parse(renderJson({ chain: CHAIN, target: TARGET }, [r("a", "warning")], "warning"));
  assert.equal(out.ok, false);
});

test("renderSarif emits a rule per check and a result only for non-ok findings", () => {
  const sarif = JSON.parse(
    renderSarif({ chain: CHAIN, target: TARGET }, [r("a", "critical"), r("b", "ok"), r("c", "skip")]),
  );
  assert.equal(sarif.version, "2.1.0");
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.rules.length, 3); // a rule for every check
  assert.equal(run.results.length, 1); // only the critical one is a result
  assert.equal(run.results[0].ruleId, "a");
  assert.equal(run.results[0].level, "error");
});
