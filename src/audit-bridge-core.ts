/**
 * Pure core behind `evmsec audit-bridge <route-id>`: which targets a bridge
 * route decomposes into, how a solvency result becomes a check report, and how
 * the multi-target report renders. No network here — the command in
 * `commands/audit-bridge.ts` does the I/O and calls in.
 */

import { ChainConfig, chain } from "./config.js";
import { CheckReport, Severity, report, renderReport, severityRank, worstSeverity } from "./check.js";
import { Route, lockLegs } from "./bridges.js";
import type { SolvencyResult } from "./commands/solvency.js";

/** One audit target derived from a route. */
export interface BridgeTarget {
  kind: "escrow" | "wrapped-token";
  /** human label, e.g. "Escrow (ethereum)". */
  label: string;
  chain: ChainConfig;
  /** EIP-55 address. */
  address: string;
}

/**
 * Decompose a route into its audit targets: every lock-leg escrow on its own
 * chain, then the wrapped token on the mint chain. Order is report order.
 */
export function planTargets(route: Route): BridgeTarget[] {
  const targets: BridgeTarget[] = [];
  for (const leg of lockLegs(route)) {
    targets.push({ kind: "escrow", label: `Escrow (${leg.chain})`, chain: chain(leg.chain), address: leg.escrow });
  }
  targets.push({
    kind: "wrapped-token",
    label: `Wrapped token (${route.mint.chain})`,
    chain: chain(route.mint.chain),
    address: route.mint.token,
  });
  return targets;
}

/**
 * Map a point-in-time solvency result onto the check-report shape so it sits
 * in the same report card as the contract checks. Severity mapping:
 * - BACKED → ok
 * - UNDERCOLLATERALIZED → critical (this is the money-printer finding)
 * - NO_SUPPLY → warning (backing unverifiable — supply reads zero)
 * - ERROR → skip (a read failed; not a pass, not a fail)
 */
export function solvencyToReport(r: SolvencyResult): CheckReport {
  const ratio = r.ratioPct === null ? "—" : `${r.ratioPct.toFixed(4)}%`;
  switch (r.verdict) {
    case "BACKED":
      return report({
        id: "solvency",
        title: "Bridge solvency",
        severity: "ok",
        summary: `backed at ${ratio} — every wrapped unit is covered by locked collateral.`,
        evidence: { locked: r.locked, minted: r.minted, backing: ratio, route: r.id },
      });
    case "UNDERCOLLATERALIZED":
      return report({
        id: "solvency",
        title: "Bridge solvency",
        severity: "critical",
        summary: `UNDERBACKED at ${ratio} — wrapped supply exceeds locked collateral by ${r.delta}.`,
        evidence: { locked: r.locked, minted: r.minted, backing: ratio, shortfall: r.delta, route: r.id },
        notes: ["A deficit here is the money-printer invariant from every nine-figure bridge hack."],
      });
    case "NO_SUPPLY":
      return report({
        id: "solvency",
        title: "Bridge solvency",
        severity: "warning",
        summary: "wrapped supply reads zero — backing is unverifiable, not confirmed.",
        evidence: { locked: r.locked, minted: r.minted, route: r.id },
        notes: ["Confirm the mint token address; a zero supply may mean a wrong address, not a safe bridge."],
      });
    case "ERROR":
      return report({
        id: "solvency",
        title: "Bridge solvency",
        severity: "skip",
        summary: `could not run: ${r.error ?? "unknown read failure"}`,
        evidence: { route: r.id },
      });
  }
}

/** One rendered section: the solvency finding plus one contract-audit target. */
export interface BridgeSection {
  /** section header, e.g. "Bridge solvency" or "Escrow (ethereum) — 0x…". */
  title: string;
  reports: CheckReport[];
}

const MARK: Record<Severity, string> = {
  critical: "✗ CRITICAL",
  warning: "⚠ WARNING",
  ok: "✓ ok",
  skip: "— skipped",
};

/** Human-readable multi-section bridge report card. */
export function renderBridgeHuman(
  route: Route,
  solvency: CheckReport,
  solvencyChain: ChainConfig,
  targets: Array<{ target: BridgeTarget; reports: CheckReport[] }>,
  failOn: Severity,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("═".repeat(72));
  lines.push(`  evmsec audit-bridge — ${route.id} · ${route.bridge} · ${route.asset}`);
  lines.push("═".repeat(72));

  lines.push("");
  lines.push("  Bridge solvency");
  lines.push("  " + "─".repeat(30));
  renderReport(solvencyChain, solvency, lines);

  for (const { target, reports } of targets) {
    lines.push("");
    lines.push(`  ${target.label} — ${target.address}`);
    lines.push("  " + "─".repeat(30));
    if (reports.length === 0) {
      lines.push("    — no code at address (EOA) — nothing applies.");
    } else {
      for (const r of reports) {
        renderReport(target.chain, r, lines);
        lines.push("");
      }
    }
  }

  const all = [solvency, ...targets.flatMap((t) => t.reports)];
  lines.push("─".repeat(72));
  lines.push("  Report card");
  lines.push("─".repeat(72));
  lines.push(`  ${MARK[solvency.severity].padEnd(12)} solvency`);
  for (const { target, reports } of targets) {
    for (const r of reports) lines.push(`  ${MARK[r.severity].padEnd(12)} ${r.id}  (${target.label})`);
  }
  lines.push("─".repeat(72));

  const worst = worstSeverity(all);
  const overall =
    worst === "critical"
      ? "✗ at least one critical finding — blocking."
      : worst === "warning"
        ? "⚠ no critical findings, but warnings worth review above."
        : worst === "skip"
          ? "— some checks could not run; treat the verdict as incomplete."
          : "✓ no blocking findings.";
  lines.push("");
  lines.push(`  OVERALL: ${overall}  (fail-on: ${failOn})`);
  lines.push("");
  lines.push("  Heuristic aggregate of on-chain reads — not a substitute for an audit.");
  lines.push("");
  return lines.join("\n");
}

/** Machine-readable bridge report for CI / piping. */
export function renderBridgeJson(
  route: Route,
  solvency: CheckReport,
  solvencyResult: SolvencyResult,
  targets: Array<{ target: BridgeTarget; reports: CheckReport[] }>,
  failOn: Severity,
): string {
  const all = [solvency, ...targets.flatMap((t) => t.reports)];
  const counts = { critical: 0, warning: 0, ok: 0, skip: 0 };
  for (const r of all) counts[r.severity]++;
  const worst = worstSeverity(all);
  return JSON.stringify(
    {
      tool: "evmsec",
      command: "audit-bridge",
      route: { id: route.id, bridge: route.bridge, asset: route.asset },
      overall: worst,
      ok: severityRank(worst) < severityRank(failOn),
      failOn,
      solvency: solvencyResult,
      targets: targets.map(({ target, reports }) => ({
        kind: target.kind,
        label: target.label,
        chain: target.chain.key,
        address: target.address,
        reports,
      })),
    },
    null,
    2,
  );
}
