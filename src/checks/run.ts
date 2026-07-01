import { ChainConfig, chain } from "../config.js";
import {
  Check,
  CheckContext,
  CheckOptions,
  CheckReport,
  Provider,
  Severity,
  renderHuman,
  renderJson,
  renderSarif,
  severityRank,
  worstSeverity,
} from "../check.js";
import { getProvider, mapWithConcurrency, requireAddress, withRetry } from "../lib.js";

const SEVERITIES: Severity[] = ["critical", "warning", "ok", "skip"];

export interface TargetAssessment {
  ctx: CheckContext;
  reports: CheckReport[];
}

/**
 * Build the shared context for one target (bytecode fetched **once**) and run the
 * applicable checks against it, isolating a per-check failure as a `skip` report.
 * The reusable core behind `runChecks` (CLI), `deps` (many targets), and the MCP
 * server. Returns an empty `reports` array when nothing applies (an EOA).
 */
export async function assessTarget(
  checks: Check[],
  provider: Provider,
  chainCfg: ChainConfig,
  target: string,
  opts: CheckOptions,
): Promise<TargetAssessment> {
  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  const ctx: CheckContext = { provider, chain: chainCfg, target, code, opts };
  const applicable = checks.filter((ch) => ch.applies(ctx));
  const concurrency = Math.max(1, Number(process.env.EVMSEC_CONCURRENCY ?? 5));
  const reports = await mapWithConcurrency(applicable, concurrency, async (ch): Promise<CheckReport> => {
    try {
      return await ch.assess(ctx);
    } catch (err) {
      return {
        id: ch.id,
        title: ch.title,
        severity: "skip",
        summary: `could not run: ${err instanceof Error ? err.message : String(err)}`,
        evidence: {},
        notes: [],
      };
    }
  });
  return { ctx, reports };
}

/**
 * The single entry point behind every contract-audit command. Parses args, builds
 * one shared context (bytecode fetched once), runs the given checks, and renders
 * the result as human text, JSON, or SARIF. A standalone command passes one
 * check; `audit` passes the whole registry.
 */
export async function runChecks(checks: Check[], args: string[], usage: string): Promise<void> {
  const p = parse(args, usage);
  const c = chain(p.chainKey);
  const provider = getProvider(c);
  const target = requireAddress(p.address);
  const opts: CheckOptions = { minDelaySec: p.minDelaySec, sourcify: p.sourcify, failOn: p.failOn };

  const { ctx, reports } = await assessTarget(checks, provider, c, target, opts);

  if (reports.length === 0) {
    // Only happens when the target has no code — nothing here applies to an EOA.
    if (p.json)
      console.log(JSON.stringify({ tool: "evmsec", target, chain: c.key, error: "no code at address" }, null, 2));
    else console.log(`\n${target} on ${c.name} has no code (EOA or self-destructed) — nothing to audit.\n`);
    process.exitCode = 1;
    return;
  }

  if (p.sarif) console.log(renderSarif(ctx, reports));
  else if (p.json) console.log(renderJson(ctx, reports, p.failOn));
  else console.log(renderHuman(ctx, reports));

  const worst = worstSeverity(reports);
  if (severityRank(worst) >= severityRank(p.failOn)) process.exitCode = 1;
}

interface Parsed {
  address: string;
  chainKey: string;
  json: boolean;
  sarif: boolean;
  minDelaySec?: number;
  sourcify?: string;
  failOn: Severity;
}

function parse(args: string[], usage: string): Parsed {
  let address: string | undefined;
  let chainKey = "ethereum";
  let json = false;
  let sarif = false;
  let minDelaySec: number | undefined;
  let sourcify: string | undefined;
  let failOn: Severity = "critical";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chain" || a === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error("--chain requires a value (e.g. --chain ethereum)");
      chainKey = args[++i];
    } else if (a === "--json") json = true;
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
    } else if (!a.startsWith("-") && !address) address = a;
  }

  if (!address) throw new Error(usage);
  return { address, chainKey, json, sarif, minDelaySec, sourcify, failOn };
}
