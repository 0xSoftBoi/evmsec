import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CheckContext, CheckOptions, Severity } from "./check.js";
import { CONTRACT_CHECKS } from "./checks/registry.js";
import { Recording, ReplayProvider } from "./testing/replay-provider.js";

/**
 * Incident fixtures — the credibility layer.
 *
 * Each fixture pins a REAL, named mainnet contract together with the exact
 * on-chain reads a check makes (captured once by `scripts/capture-fixtures.ts`).
 * Here we replay those reads through the *actual* assessors with no network, and
 * assert the verdict evmsec produces. If a heuristic drifts, these break — so the
 * claims in the README ("USDC's proxy admin is a single key") stay honest, and a
 * real contract's judgment can't silently change under us.
 */

interface Fixture {
  name: string;
  description: string;
  source: string;
  chain: string;
  chainId: number;
  address: string;
  expect: Partial<Record<string, Severity>>;
  actual: Record<string, Severity>;
  recordings: Recording[];
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "incidents");

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);
}

// Verification hits Sourcify over HTTP, so it isn't part of the replay set.
const REPLAYABLE = CONTRACT_CHECKS.filter((c) => c.id !== "verification-status");

for (const fx of loadFixtures()) {
  test(`incident fixture: ${fx.name} — reproduces its recorded verdicts offline`, async () => {
    const provider = new ReplayProvider(fx.recordings, fx.chainId);
    const chainCfg = { key: fx.chain, name: fx.chain, chainId: fx.chainId, explorer: "" } as never;
    const opts: CheckOptions = { failOn: "critical" };
    const code = await provider.getCode(fx.address);
    const ctx: CheckContext = { provider: provider as never, chain: chainCfg, target: fx.address, code, opts };

    for (const check of REPLAYABLE) {
      if (!check.applies(ctx)) continue;
      const rep = await check.assess(ctx);

      // (1) offline replay reproduces exactly what was captured on-chain.
      assert.equal(
        rep.severity,
        fx.actual[check.id],
        `${fx.name}/${check.id}: replayed severity ${rep.severity} != recorded ${fx.actual[check.id]}`,
      );

      // (2) the curated, documented expectation still holds.
      const want = fx.expect[check.id];
      if (want !== undefined) {
        assert.equal(rep.severity, want, `${fx.name}/${check.id}: expected ${want}, got ${rep.severity}`);
      }
    }
  });
}

test("incident fixtures: at least the core set is present", () => {
  const names = loadFixtures().map((f) => f.name);
  for (const required of ["usdc-fiattokenproxy", "dai-non-upgradeable", "compound-cusdc"]) {
    assert.ok(names.includes(required), `missing fixture: ${required}`);
  }
});
