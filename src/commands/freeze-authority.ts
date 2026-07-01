import { runChecks } from "../checks/run.js";
import { freezeAuthorityCheck } from "../checks/freeze.js";

/** `evmsec freeze-authority <token>` — can individual holders be frozen/seized, and by whom? */
export function freezeAuthority(args: string[]): Promise<void> {
  return runChecks(
    [freezeAuthorityCheck],
    args,
    "usage: evmsec freeze-authority <token> [--chain ethereum] [--json|--sarif]",
  );
}
