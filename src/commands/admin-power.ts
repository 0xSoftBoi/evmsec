import { runChecks } from "../checks/run.js";
import { authorityCheck } from "../checks/authority.js";

/** `evmsec admin-power <address>` — what kind of authority controls it (EOA / Safe / timelock)? */
export function adminPower(args: string[]): Promise<void> {
  return runChecks(
    [authorityCheck],
    args,
    "usage: evmsec admin-power <address> [--chain ethereum] [--min-delay <hours>] [--json|--sarif]",
  );
}
