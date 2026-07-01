import { runChecks } from "../checks/run.js";
import { verificationCheck } from "../checks/verification.js";

/** `evmsec verification-status <address>` — is the contract's source verified? (Sourcify) */
export function verificationStatus(args: string[]): Promise<void> {
  return runChecks(
    [verificationCheck],
    args,
    "usage: evmsec verification-status <address> [--chain ethereum] [--sourcify <url>] [--json|--sarif]",
  );
}
