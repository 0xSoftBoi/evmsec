import { chain } from "../config.js";
import { getProvider, requireAddress, withRetry } from "../lib.js";
import { upgradeability } from "./upgradeability.js";
import { adminPower } from "./admin-power.js";
import { mintAuthority } from "./mint-authority.js";
import { pauseGuardian } from "./pause-guardian.js";
import { compilerBugs } from "./compiler-bugs.js";
import { verificationStatus } from "./verification-status.js";

/**
 * `evmsec audit <address> [--chain ethereum]`
 *
 * The meta-command: runs every check that applies to a generic contract and
 * prints one consolidated report card with a pass/fail per check and an overall
 * verdict. Exit code is non-zero if *any* check fails, so a single
 * `evmsec audit 0x… || alert` line covers the lot in CI.
 *
 * Oracle-hygiene is intentionally excluded — it only applies to price feeds and
 * would revert on a generic contract; run it explicitly when relevant.
 */
interface Check {
  name: string;
  run: (args: string[]) => Promise<void>;
}

const CHECKS: Check[] = [
  { name: "verification-status", run: verificationStatus },
  { name: "compiler-bugs", run: compilerBugs },
  { name: "upgradeability", run: upgradeability },
  { name: "admin-power", run: adminPower },
  { name: "mint-authority", run: mintAuthority },
  { name: "pause-guardian", run: pauseGuardian },
];

export async function audit(args: string[]): Promise<void> {
  const { address, chainKey } = parse(args);
  if (!address) throw new Error("usage: evmsec audit <address> [--chain ethereum]");

  const c = chain(chainKey);
  const target = requireAddress(address);
  const provider = getProvider(c);

  // Nothing to audit at an EOA — short-circuit before fanning out.
  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  if (code === "0x") {
    console.log(`\n${target} on ${c.name} has no code (EOA or self-destructed) — nothing to audit.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  evmsec audit — ${target} on ${c.name}`);
  console.log(`${"═".repeat(72)}`);

  const checkArgs = [target, "--chain", chainKey];
  const results: { name: string; failed: boolean; errored: boolean }[] = [];

  for (const check of CHECKS) {
    // Each command sets process.exitCode = 1 on a failing verdict. Snapshot and
    // reset around each so we can read its individual result, then aggregate.
    const prior = process.exitCode;
    process.exitCode = 0;
    let errored = false;
    try {
      await check.run(checkArgs);
    } catch (err) {
      errored = true;
      console.log(`\n  [${check.name}] could not run: ${err instanceof Error ? err.message : err}`);
    }
    const failed = process.exitCode === 1;
    results.push({ name: check.name, failed, errored });
    process.exitCode = prior; // restore; final aggregate is set below
  }

  // Report card.
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  Report card — ${target} on ${c.name}`);
  console.log(`${"─".repeat(72)}`);
  for (const r of results) {
    const mark = r.errored ? "— SKIPPED" : r.failed ? "✗ FAIL" : "✓ pass";
    console.log(`  ${mark.padEnd(10)} ${r.name}`);
  }
  const anyFail = results.some((r) => r.failed);
  console.log(`${"─".repeat(72)}`);
  console.log(
    anyFail
      ? `  OVERALL: ✗ at least one check flagged a critical/blocking finding above.`
      : `  OVERALL: ✓ no blocking findings — review the elevated/info notes above.`,
  );
  console.log(`\n  A heuristic aggregate of on-chain reads — not a substitute for an audit.\n`);

  if (anyFail) process.exitCode = 1;
}

function parse(args: string[]): { address?: string; chainKey: string } {
  let address: string | undefined;
  let chainKey = "ethereum";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error("--chain requires a value (e.g. --chain ethereum)");
      chainKey = args[++i];
    } else if (!address) address = args[i];
  }
  return { address, chainKey };
}
