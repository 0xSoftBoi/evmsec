import { runChecks } from "../checks/run.js";
import { pauseGuardianCheck } from "../checks/pause.js";

/** `evmsec pause-guardian <token>` — can transfers be frozen, are they now, and who holds the key? */
export function pauseGuardian(args: string[]): Promise<void> {
  return runChecks(
    [pauseGuardianCheck],
    args,
    "usage: evmsec pause-guardian <token> [--chain ethereum] [--json|--sarif]",
  );
}
