import { runChecks } from "../checks/run.js";
import { mintAuthorityCheck } from "../checks/mint.js";

/** `evmsec mint-authority <token>` — can the supply be inflated, and by whom? */
export function mintAuthority(args: string[]): Promise<void> {
  return runChecks(
    [mintAuthorityCheck],
    args,
    "usage: evmsec mint-authority <token> [--chain ethereum] [--json|--sarif]",
  );
}
