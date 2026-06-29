import { to18 } from "./lib.js";

/**
 * Pure solvency helpers — no network. Kept here so the multi-asset summation,
 * the breach predicate, and the `--watch` transition logic can be unit-tested.
 */

/** One locked leg's raw balance and its token decimals. */
export interface LockedLeg {
  raw: bigint;
  decimals: number;
}

/** Sum locked legs into a common 18-dp fixed point (multi-asset / multi-escrow). */
export function sumLocked18(legs: LockedLeg[]): bigint {
  return legs.reduce((acc, leg) => acc + to18(leg.raw, leg.decimals), 0n);
}

/** The verdict/ratio fields the failure predicate needs. */
export interface SolvencyVerdictView {
  verdict: "BACKED" | "UNDERCOLLATERALIZED" | "NO_SUPPLY" | "ERROR";
  ratioPct: number | null;
}

/**
 * Should this route trip the exit code / fire a watch alert? A breach, an
 * unverifiable read (ERROR), or backing below the configured threshold. Used by
 * both the one-shot exit logic and `--watch` so they can't drift apart.
 */
export function isRouteFailing(r: SolvencyVerdictView, minRatio: number): boolean {
  return r.verdict === "UNDERCOLLATERALIZED" || r.verdict === "ERROR" || (r.ratioPct !== null && r.ratioPct < minRatio);
}

export type TransitionKind = "breach" | "recovery";
export interface Transition {
  id: string;
  kind: TransitionKind;
}

/**
 * Compare the previous failing-state map with the current results and return the
 * transitions worth alerting on: a route newly failing (`breach`) or newly
 * healthy again (`recovery`). De-dupes steady state — a route that stays broken
 * does not re-alert. A first-ever sighting that is already failing counts as a
 * breach so `--watch` alerts at startup on a pre-existing problem.
 */
export function computeTransitions(
  prev: Map<string, boolean>,
  current: Array<{ id: string; failing: boolean }>,
): Transition[] {
  const out: Transition[] = [];
  for (const c of current) {
    const was = prev.get(c.id);
    if (c.failing && was !== true) out.push({ id: c.id, kind: "breach" });
    else if (!c.failing && was === true) out.push({ id: c.id, kind: "recovery" });
  }
  return out;
}

export interface Degrade {
  id: string;
  from: number;
  to: number;
}

/**
 * Detect routes whose backing dropped by at least `deltaPct` points since the
 * previous observation — a sudden degradation worth alerting on even while still
 * above the breach threshold. Compared against the immediately-previous reading
 * (which the caller then updates), so a single drop alerts once.
 */
export function computeDegrades(
  prev: Map<string, number | null>,
  current: Array<{ id: string; ratioPct: number | null }>,
  deltaPct: number,
): Degrade[] {
  const out: Degrade[] = [];
  for (const c of current) {
    if (c.ratioPct === null) continue;
    const was = prev.get(c.id);
    if (typeof was === "number" && was - c.ratioPct >= deltaPct) {
      out.push({ id: c.id, from: was, to: c.ratioPct });
    }
  }
  return out;
}
