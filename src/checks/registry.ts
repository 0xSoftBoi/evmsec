import { Check } from "../check.js";
import { verificationCheck } from "./verification.js";
import { compilerBugsCheck } from "./compiler.js";
import { upgradeabilityCheck } from "./upgradeability.js";
import { authorityCheck } from "./authority.js";
import { mintAuthorityCheck } from "./mint.js";
import { pauseGuardianCheck } from "./pause.js";
import { freezeAuthorityCheck } from "./freeze.js";

/**
 * The contract-audit family, in report order. `evmsec audit` runs all of them;
 * each is also exposed as a standalone command that runs just itself.
 *
 * Oracle-hygiene, solvency, settlement, message-proof, and pq-readiness are not
 * here: they have a different shape (a price feed, a route, a tx pair, a VAA)
 * and would not apply to a generic contract address.
 */
export const CONTRACT_CHECKS: Check[] = [
  verificationCheck,
  compilerBugsCheck,
  upgradeabilityCheck,
  authorityCheck,
  mintAuthorityCheck,
  pauseGuardianCheck,
  freezeAuthorityCheck,
];
