/**
 * The check framework — one contract for every on-chain security check.
 *
 * Before this, each command re-implemented argument parsing, `getCode`, proxy
 * resolution, a bespoke result shape, and its own printer; the `audit`
 * meta-command faked aggregation by snooping `process.exitCode` between runs.
 * This replaces all of that.
 *
 * A `Check` is a pure-ish unit: given a shared `CheckContext` (provider, chain,
 * target, and the target's bytecode fetched *once*), it returns a structured
 * `CheckReport`. The runner (see `checks/run.ts`) builds the context, runs one
 * check or many, and renders the reports as human text, JSON, or SARIF — so the
 * same logic drives both `evmsec admin-power` and `evmsec audit`, and every
 * check gets machine-readable output for free.
 */

import { ChainConfig } from "./config.js";
import { addrLink, getProvider } from "./lib.js";

export type Provider = ReturnType<typeof getProvider>;

/** Ordered worst→best. `skip` means the check didn't apply (not a pass, not a fail). */
export type Severity = "critical" | "warning" | "ok" | "skip";

const RANK: Record<Severity, number> = { critical: 3, warning: 2, ok: 1, skip: 0 };

export function severityRank(s: Severity): number {
  return RANK[s];
}

/** The worst (highest-rank) severity among reports, or "skip" if there are none. */
export function worstSeverity(reports: CheckReport[]): Severity {
  return reports.reduce<Severity>((acc, r) => (RANK[r.severity] > RANK[acc] ? r.severity : acc), "skip");
}

export interface CheckReport {
  /** stable id, e.g. "admin-power" — also the SARIF ruleId. */
  id: string;
  /** human title, e.g. "Admin power". */
  title: string;
  severity: Severity;
  /** the one-line verdict. */
  summary: string;
  /** ordered, structured facts — addresses get explorer links in human output. */
  evidence: Record<string, string | number | boolean | null>;
  /** extra context lines (indicators, role holders, caveats). */
  notes: string[];
}

export interface CheckOptions {
  /** timelock floor (seconds) below which a delay is flagged. */
  minDelaySec?: number;
  /** Sourcify server base URL override. */
  sourcify?: string;
  /** severity at or above which the process exits non-zero. Default "critical". */
  failOn: Severity;
}

export interface CheckContext {
  provider: Provider;
  chain: ChainConfig;
  /** EIP-55 target address. */
  target: string;
  /** `eth_getCode(target)` — fetched once and shared across every check. */
  code: string;
  opts: CheckOptions;
}

export interface Check {
  id: string;
  title: string;
  /** does this check apply to the target? Most need deployed code. */
  applies(ctx: CheckContext): boolean;
  assess(ctx: CheckContext): Promise<CheckReport>;
}

/** Convenience for assessors: build a report, defaulting empty evidence/notes. */
export function report(
  r: Omit<CheckReport, "evidence" | "notes"> & Partial<Pick<CheckReport, "evidence" | "notes">>,
): CheckReport {
  return { evidence: {}, notes: [], ...r };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const MARK: Record<Severity, string> = {
  critical: "✗ CRITICAL",
  warning: "⚠ WARNING",
  ok: "✓ ok",
  skip: "— skipped",
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function renderReport(c: ChainConfig, r: CheckReport, lines: string[]): void {
  lines.push(`  ${r.title.padEnd(22)} ${MARK[r.severity]}`);
  lines.push(`    ${r.summary}`);
  for (const [k, v] of Object.entries(r.evidence)) {
    const val = v === null ? "—" : String(v);
    lines.push(`      ${k.padEnd(16)} ${val}`);
    if (typeof v === "string" && ADDR_RE.test(v)) lines.push(`      ${" ".repeat(16)} ${addrLink(c, v)}`);
  }
  for (const note of r.notes) lines.push(`      · ${note}`);
}

/** Human-readable rendering of one or many reports. */
export function renderHuman(ctx: { chain: ChainConfig; target: string }, reports: CheckReport[]): string {
  const c = ctx.chain;
  const lines: string[] = [];
  const multi = reports.length > 1;

  lines.push("");
  lines.push("═".repeat(72));
  lines.push(`  ${multi ? "evmsec audit" : (reports[0]?.title ?? "evmsec")} — ${ctx.target} on ${c.name}`);
  lines.push("═".repeat(72));

  for (const r of reports) {
    lines.push("");
    renderReport(c, r, lines);
  }

  if (multi) {
    lines.push("");
    lines.push("─".repeat(72));
    lines.push("  Report card");
    lines.push("─".repeat(72));
    for (const r of reports) lines.push(`  ${MARK[r.severity].padEnd(12)} ${r.id}`);
    lines.push("─".repeat(72));
  }

  const worst = worstSeverity(reports);
  const overall =
    worst === "critical"
      ? "✗ at least one critical finding — blocking."
      : worst === "warning"
        ? "⚠ no critical findings, but warnings worth review above."
        : "✓ no blocking findings.";
  lines.push("");
  lines.push(`  OVERALL: ${overall}`);
  lines.push("");
  lines.push("  Heuristic aggregate of on-chain reads — not a substitute for an audit.");
  lines.push("");
  return lines.join("\n");
}

/** Structured JSON for CI / piping. */
export function renderJson(
  ctx: { chain: ChainConfig; target: string },
  reports: CheckReport[],
  failOn: Severity,
): string {
  const counts = { critical: 0, warning: 0, ok: 0, skip: 0 };
  for (const r of reports) counts[r.severity]++;
  const worst = worstSeverity(reports);
  return JSON.stringify(
    {
      tool: "evmsec",
      target: ctx.target,
      chain: ctx.chain.key,
      chainId: ctx.chain.chainId,
      overall: worst,
      ok: severityRank(worst) < severityRank(failOn),
      counts,
      reports,
    },
    null,
    2,
  );
}

/** SARIF 2.1.0 — drops findings into the GitHub code-scanning / Security tab. */
export function renderSarif(ctx: { chain: ChainConfig; target: string }, reports: CheckReport[]): string {
  const sarifLevel: Record<Severity, string> = { critical: "error", warning: "warning", ok: "note", skip: "none" };
  const rules = reports.map((r) => ({
    id: r.id,
    name: r.title.replace(/\s+/g, ""),
    shortDescription: { text: r.title },
    helpUri: "https://github.com/0xSoftBoi/evmsec",
  }));
  const results = reports
    .filter((r) => r.severity !== "skip" && r.severity !== "ok")
    .map((r) => ({
      ruleId: r.id,
      level: sarifLevel[r.severity],
      message: { text: `${r.summary}${r.notes.length ? "\n- " + r.notes.join("\n- ") : ""}` },
      properties: { target: ctx.target, chain: ctx.chain.key, evidence: r.evidence },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: `${ctx.chain.key}/${ctx.target}` },
            region: { startLine: 1 },
          },
        },
      ],
    }));

  return JSON.stringify(
    {
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "evmsec", informationUri: "https://github.com/0xSoftBoi/evmsec", rules } },
          results,
        },
      ],
    },
    null,
    2,
  );
}
