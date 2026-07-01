import { readFileSync } from "node:fs";
import { CHAINS, ChainConfig, chain } from "../config.js";
import {
  CheckOptions,
  CheckReport,
  Severity,
  SarifTarget,
  renderSarifMulti,
  severityRank,
  worstSeverity,
} from "../check.js";
import { addrLink, getProvider, requireAddress } from "../lib.js";
import { Dependency, validateDeps } from "../deps-core.js";
import { CONTRACT_CHECKS } from "../checks/registry.js";
import { assessTarget } from "../checks/run.js";

const SEVERITIES: Severity[] = ["critical", "warning", "ok", "skip"];
const MARK: Record<Severity, string> = {
  critical: "✗ CRITICAL",
  warning: "⚠ WARNING",
  ok: "✓ ok",
  skip: "— skipped",
};

/**
 * `evmsec deps [manifest] [--fail-on <sev>] [--json|--sarif]`
 *
 * Audit your on-chain supply chain — the external contracts your protocol trusts
 * (USDC, a Chainlink feed, a bridge). Runs the full audit family against every
 * entry in a `deps.json` manifest and rolls the results into one verdict, so a
 * dependency quietly becoming single-key-controlled fails your CI.
 */
export async function deps(args: string[]): Promise<void> {
  const p = parse(args);
  const raw = readManifest(p.file);
  const { deps: list, errors } = validateDeps(raw, Object.keys(CHAINS));

  if (errors.length) {
    if (p.json) console.log(JSON.stringify({ tool: "evmsec", error: "invalid manifest", details: errors }, null, 2));
    else console.error(`\ninvalid dependency manifest (${p.file}):\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
    process.exitCode = 1;
    if (list.length === 0) return;
  }

  const opts: CheckOptions = { failOn: p.failOn };
  const assessed = await Promise.all(
    list.map(async (dep) => {
      const c = chain(dep.chain);
      const provider = getProvider(c);
      const { reports } = await assessTarget(CONTRACT_CHECKS, provider, c, requireAddress(dep.address), opts);
      return { dep, chainCfg: c, reports, worst: worstSeverity(reports) };
    }),
  );

  const overall = assessed.reduce<Severity>(
    (acc, a) => (severityRank(a.worst) > severityRank(acc) ? a.worst : acc),
    "skip",
  );

  if (p.sarif) {
    const targets: SarifTarget[] = assessed.map((a) => ({
      chain: a.chainCfg,
      target: a.dep.address,
      reports: a.reports,
    }));
    console.log(renderSarifMulti(targets));
  } else if (p.json) {
    console.log(renderJson(assessed, overall, p.failOn));
  } else {
    console.log(renderHuman(assessed));
  }

  if (severityRank(overall) >= severityRank(p.failOn)) process.exitCode = 1;
}

interface Assessed {
  dep: Dependency;
  chainCfg: ChainConfig;
  reports: CheckReport[];
  worst: Severity;
}

function renderHuman(assessed: Assessed[]): string {
  const lines: string[] = [
    "",
    "═".repeat(72),
    `  evmsec deps — ${assessed.length} on-chain dependenc${assessed.length === 1 ? "y" : "ies"}`,
    "═".repeat(72),
  ];
  for (const a of assessed) {
    lines.push("");
    lines.push(`  ${MARK[a.worst].padEnd(12)} ${a.dep.label}  (${a.dep.chain})`);
    lines.push(`               ${a.dep.address}`);
    lines.push(`               ${addrLink(a.chainCfg, a.dep.address)}`);
    for (const r of a.reports.filter((r) => r.severity === "critical" || r.severity === "warning")) {
      lines.push(`      ${MARK[r.severity].padEnd(12)} ${r.id}: ${r.summary}`);
    }
  }
  lines.push("");
  lines.push("─".repeat(72));
  const crit = assessed.filter((a) => a.worst === "critical").length;
  const warn = assessed.filter((a) => a.worst === "warning").length;
  lines.push(`  ${crit} critical · ${warn} warning · ${assessed.length - crit - warn} clean`);
  lines.push(
    crit
      ? "  OVERALL: ✗ a dependency has a critical finding — blocking."
      : warn
        ? "  OVERALL: ⚠ dependencies with warnings — review above."
        : "  OVERALL: ✓ no blocking findings across your dependencies.",
  );
  lines.push("");
  return lines.join("\n");
}

function renderJson(assessed: Assessed[], overall: Severity, failOn: Severity): string {
  return JSON.stringify(
    {
      tool: "evmsec",
      command: "deps",
      overall,
      ok: severityRank(overall) < severityRank(failOn),
      dependencies: assessed.map((a) => ({
        label: a.dep.label,
        chain: a.dep.chain,
        address: a.dep.address,
        overall: a.worst,
        reports: a.reports,
      })),
    },
    null,
    2,
  );
}

function readManifest(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`could not read dependency manifest "${file}" (create one, or pass a path / set EVMSEC_DEPS)`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest "${file}" is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

function parse(args: string[]): { file: string; json: boolean; sarif: boolean; failOn: Severity } {
  let file = process.env.EVMSEC_DEPS ?? "deps.json";
  let json = false;
  let sarif = false;
  let failOn: Severity = "critical";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file" || a === "-f") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--file requires a path");
      file = args[++i];
    } else if (a === "--json") json = true;
    else if (a === "--sarif") sarif = true;
    else if (a === "--fail-on") {
      const next = args[++i] as Severity;
      if (!SEVERITIES.includes(next)) throw new Error(`--fail-on must be one of: ${SEVERITIES.join(", ")}`);
      failOn = next;
    } else if (!a.startsWith("-")) file = a;
  }
  return { file, json, sarif, failOn };
}
