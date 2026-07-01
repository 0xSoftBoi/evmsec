/**
 * Capture incident fixtures: run the real assessors against live mainnet through
 * a RecordingProvider, verify each verdict matches the stated expectation, and
 * write a committed fixture (recording + expectation) that the offline test
 * replays. Run with:  npx tsx scripts/capture-fixtures.ts
 *
 * Each spec pins a REAL, named contract and the severity we expect evmsec to
 * assign — so the tool's judgments can't silently drift, and the claims in the
 * README are regression-tested against actual chain state.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chain } from "../src/config.js";
import { CheckContext, CheckOptions, Severity } from "../src/check.js";
import { CONTRACT_CHECKS } from "../src/checks/registry.js";
import { RecordingProvider } from "../src/testing/replay-provider.js";

interface Spec {
  name: string;
  description: string;
  source: string;
  chain: string;
  address: string;
  /** expected severity per check id. Checks not listed are not asserted. */
  expect: Partial<Record<string, Severity>>;
}

const SPECS: Spec[] = [
  {
    name: "usdc-fiattokenproxy",
    description:
      "USDC (FiatTokenProxy). Its upgrade admin is a single externally-owned key, not a multisig — a real, live centralization fact behind one of the largest tokens on Ethereum.",
    source: "https://etherscan.io/address/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48#code",
    chain: "ethereum",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    expect: { "admin-power": "critical", upgradeability: "critical", "compiler-bugs": "warning" },
  },
  {
    name: "dai-non-upgradeable",
    description:
      "DAI — non-upgradeable and non-Ownable (MakerDAO `wards` auth). Negative control for upgradeability (not a proxy → ok); admin-power can't resolve a standard controller and correctly reports a review item rather than a clean pass.",
    source: "https://etherscan.io/address/0x6B175474E89094C44Da98b954EedeAC495271d0F#code",
    chain: "ethereum",
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    expect: { upgradeability: "ok", "admin-power": "warning" },
  },
  {
    name: "usdt-tether",
    description:
      "Tether USD (USDT) — the largest stablecoin, an Ownable TetherToken. Its owner is an unrecognized controller contract (not a Gnosis Safe or timelock), so admin-power flags it for inspection rather than passing it.",
    source: "https://etherscan.io/address/0xdAC17F958D2ee523a2206206994597C13D831ec7#code",
    chain: "ethereum",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    expect: { "admin-power": "warning", upgradeability: "ok" },
  },
  {
    name: "wbtc",
    description:
      "Wrapped BTC (WBTC) — Ownable, controlled by a custom multisig contract that is not a recognized Gnosis Safe or timelock. admin-power flags the unrecognized controller for inspection.",
    source: "https://etherscan.io/address/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599#code",
    chain: "ethereum",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    expect: { "admin-power": "warning", upgradeability: "ok" },
  },
  {
    name: "compound-cusdc",
    description:
      "Compound cUSDC (CErc20Delegator). Its admin lives behind Compound's non-standard `admin()` getter — not EIP-1967 or Ownable — so admin-power reports it as unresolved (a documented blind spot: evmsec resolves EIP-1967 proxy admins and `owner()`, not every custom scheme). Pins that we warn rather than falsely pass.",
    source: "https://etherscan.io/address/0x39AA39c021dfbaE8faC545936693aC917d5E7563",
    chain: "ethereum",
    address: "0x39AA39c021dfbaE8faC545936693aC917d5E7563",
    expect: { "admin-power": "warning", upgradeability: "ok" },
  },
];

async function main(): Promise<void> {
  const outDir = "src/fixtures/incidents";
  mkdirSync(outDir, { recursive: true });
  let failures = 0;

  for (const spec of SPECS) {
    const c = chain(spec.chain);
    const provider = new RecordingProvider(c.rpcUrl);
    const opts: CheckOptions = { failOn: "critical" };
    const target = spec.address;
    const code = await provider.getCode(target);
    const ctx: CheckContext = { provider: provider as never, chain: c, target, code, opts };

    const actual: Record<string, Severity> = {};
    for (const check of CONTRACT_CHECKS) {
      if (!check.applies(ctx)) continue;
      if (check.id === "verification-status") continue; // Sourcify is an HTTP call, not replayable here
      try {
        const rep = await check.assess(ctx);
        actual[check.id] = rep.severity;
      } catch (err) {
        actual[check.id] = "skip";
        console.error(`  ${spec.name}/${check.id} errored:`, err instanceof Error ? err.message : err);
      }
    }

    // Verify expectations.
    const mismatches: string[] = [];
    for (const [id, want] of Object.entries(spec.expect)) {
      if (actual[id] !== want) mismatches.push(`${id}: expected ${want}, got ${actual[id]}`);
    }

    // Dedupe recordings by key (last wins).
    const byKey = new Map<string, (typeof provider.recordings)[number]>();
    for (const r of provider.recordings) byKey.set(r.key, r);

    const fixture = {
      name: spec.name,
      description: spec.description,
      source: spec.source,
      chain: spec.chain,
      chainId: c.chainId,
      address: target,
      expect: spec.expect,
      actual,
      recordings: [...byKey.values()],
    };
    writeFileSync(`${outDir}/${spec.name}.json`, JSON.stringify(fixture, null, 2) + "\n");

    const status = mismatches.length ? `✗ MISMATCH (${mismatches.join("; ")})` : "✓";
    console.log(`${status}  ${spec.name}  actual=${JSON.stringify(actual)}  (${byKey.size} reads)`);
    if (mismatches.length) failures++;
  }

  console.log(failures ? `\n${failures} spec(s) mismatched — review before committing.` : "\nall specs matched.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
