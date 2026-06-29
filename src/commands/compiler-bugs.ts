import { runChecks } from "../checks/run.js";
import { compilerBugsCheck } from "../checks/compiler.js";

/** `evmsec compiler-bugs <address>` — built with a solc version that has a known bug? */
export function compilerBugs(args: string[]): Promise<void> {
  return runChecks(
    [compilerBugsCheck],
    args,
    "usage: evmsec compiler-bugs <address> [--chain ethereum] [--json|--sarif]",
  );
}
