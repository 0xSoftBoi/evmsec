import { runChecks } from "../checks/run.js";
import { upgradeabilityCheck } from "../checks/upgradeability.js";

/** `evmsec upgradeability <address>` — is it an upgradeable proxy, and who controls it? */
export function upgradeability(args: string[]): Promise<void> {
  return runChecks(
    [upgradeabilityCheck],
    args,
    "usage: evmsec upgradeability <address> [--chain ethereum] [--json|--sarif]",
  );
}
