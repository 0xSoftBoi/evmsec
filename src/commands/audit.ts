import { runChecks } from "../checks/run.js";
import { CONTRACT_CHECKS } from "../checks/registry.js";

/**
 * `evmsec audit <address>` — run every check that applies to a generic contract
 * and print one report card. Exit code is non-zero if any check reaches the
 * `--fail-on` severity (default `critical`). `--json` / `--sarif` emit the
 * aggregate machine-readable; SARIF drops findings into the GitHub Security tab.
 */
export function audit(args: string[]): Promise<void> {
  return runChecks(
    CONTRACT_CHECKS,
    args,
    "usage: evmsec audit <address> [--chain ethereum] [--min-delay <hours>] [--fail-on warning] [--json|--sarif]",
  );
}
