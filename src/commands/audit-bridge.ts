import { chain } from "../config.js";
import { findRoute } from "../bridges.js";
import { checkAll } from "./solvency.js";
import { CONTRACT_CHECKS } from "../checks/registry.js";
import { assessTarget } from "../checks/run.js";
import { getProvider, requireAddress } from "../lib.js";
import { CheckOptions, Severity, renderSarifMulti, severityRank, worstSeverity } from "../check.js";
import {
  BridgeTarget,
  planTargets,
  renderBridgeHuman,
  renderBridgeJson,
  solvencyToReport,
} from "../audit-bridge-core.js";

const SEVERITIES: Severity[] = ["critical", "warning", "ok", "skip"];

const USAGE = "usage: evmsec audit-bridge <route-id> [--min-delay <hours>] [--fail-on warning] [--json|--sarif]";

/**
 * `evmsec audit-bridge <route-id>` — one report card for a whole bridge route:
 * the solvency invariant plus the full contract-audit check family run against
 * every lock-leg escrow (source chains) and the wrapped token (mint chain).
 * Exit code is non-zero if any finding reaches `--fail-on` (default `critical`).
 */
export async function auditBridge(args: string[]): Promise<void> {
  const p = parse(args, USAGE);
  const route = findRoute(p.routeId);

  // 1. Solvency — the money-printer invariant, mapped onto a check report.
  const [solvencyResult] = await checkAll([route]);
  const solvencyReport = solvencyToReport(solvencyResult);

  // 2. Contract checks against each escrow and the wrapped token.
  const opts: CheckOptions = { minDelaySec: p.minDelaySec, sourcify: p.sourcify, failOn: p.failOn };
  const assessed: Array<{ target: BridgeTarget; reports: import("../check.js").CheckReport[] }> = [];
  for (const t of planTargets(route)) {
    const provider = getProvider(t.chain);
    const address = requireAddress(t.address, `${t.label} address`);
    const { reports } = await assessTarget(CONTRACT_CHECKS, provider, t.chain, address, opts);
    assessed.push({ target: { ...t, address }, reports });
  }

  // 3. Render + exit code.
  const all = [solvencyReport, ...assessed.flatMap((a) => a.reports)];
  if (p.sarif) {
    // Anchor the solvency finding at the wrapped token so SARIF has a location.
    const mintChain = chain(route.mint.chain);
    const mintToken = requireAddress(route.mint.token, "mint token address");
    console.log(
      renderSarifMulti([
        { chain: mintChain, target: mintToken, reports: [solvencyReport] },
        ...assessed.map((a) => ({ chain: a.target.chain, target: a.target.address, reports: a.reports })),
      ]),
    );
  } else if (p.json) {
    console.log(renderBridgeJson(route, solvencyReport, solvencyResult, assessed, p.failOn));
  } else {
    console.log(renderBridgeHuman(route, solvencyReport, chain(route.mint.chain), assessed, p.failOn));
  }

  const worst = worstSeverity(all);
  if (severityRank(worst) >= severityRank(p.failOn)) process.exitCode = 1;
}

interface Parsed {
  routeId: string;
  json: boolean;
  sarif: boolean;
  minDelaySec?: number;
  sourcify?: string;
  failOn: Severity;
}

function parse(args: string[], usage: string): Parsed {
  let routeId: string | undefined;
  let json = false;
  let sarif = false;
  let minDelaySec: number | undefined;
  let sourcify: string | undefined;
  let failOn: Severity = "critical";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--sarif") sarif = true;
    else if (a === "--min-delay") {
      const hours = Number(args[++i]);
      if (!Number.isFinite(hours) || hours < 0) throw new Error("--min-delay requires a non-negative number of hours");
      minDelaySec = Math.round(hours * 3600);
    } else if (a === "--sourcify") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--sourcify requires a server URL");
      sourcify = args[++i];
    } else if (a === "--fail-on") {
      const next = args[++i] as Severity;
      if (!SEVERITIES.includes(next)) throw new Error(`--fail-on must be one of: ${SEVERITIES.join(", ")}`);
      failOn = next;
    } else if (!a.startsWith("-") && !routeId) routeId = a;
  }

  if (!routeId) throw new Error(usage);
  return { routeId, json, sarif, minDelaySec, sourcify, failOn };
}
