/**
 * Pure core behind `evmsec authority <snapshot|check|watch>`: the snapshot
 * shape, the drift diff, alert-once transition tracking, and rendering.
 * No network here — capture lives in `checks/onchain.ts`, the loop in
 * `commands/authority.ts`.
 *
 * The thesis: in 2026, compromised keys — not broken code — became crypto's
 * dominant loss vector (~76% of stolen value, TRM Labs H1 2026). Every major
 * bridge incident was a *change* in who could sign. This diffs the
 * authority-relevant state of monitored addresses against a committed
 * baseline and fails/alerts on ANY change.
 */

export type MonitoredKind = "eoa" | "safe" | "timelock" | "contract" | "unknown";

/** One address's authority-relevant state at a point in time. */
export interface AuthoritySnapshot {
  /** EIP-55 monitored address. */
  address: string;
  /** chain key, e.g. "ethereum". */
  chain: string;
  /** human label, e.g. "Polygon PoS escrow authority". */
  label: string;
  /** ISO capture time. */
  capturedAt: string;
  kind: MonitoredKind;
  /** keccak256 of the target's code ("0x" for EOAs). */
  codehash: string;
  /** Safe only: sorted EIP-55 owners. */
  owners?: string[];
  /** Safe only. */
  threshold?: number;
  /** Safe only: sorted EIP-55 enabled modules. */
  modules?: string[];
  /** Timelock only: configured min delay, seconds. */
  minDelaySec?: number;
  /** EOA only: EIP-7702 delegate target, if the EOA has delegated code. */
  delegation?: string | null;
  /**
   * When the entry was captured by resolving another contract's authority
   * (`--route` mode), the label of the contract this authority guards.
   */
  guards?: string;
}

export interface BaselineFile {
  version: 1;
  snapshots: AuthoritySnapshot[];
}

/** One field that changed between baseline and current. */
export interface Drift {
  address: string;
  chain: string;
  label: string;
  field: string;
  before: string;
  after: string;
}

export function snapshotKey(s: Pick<AuthoritySnapshot, "address" | "chain">): string {
  return `${s.chain}:${s.address.toLowerCase()}`;
}

/**
 * EIP-7702 delegation target from account code, or null. Delegated code is
 * exactly `0xef0100 || address` (23 bytes); anything else is not a delegation.
 */
export function delegationTarget(code: string): string | null {
  const lower = code.toLowerCase();
  // "0x" (2) + "ef0100" (6) + address (40) = 48 chars exactly.
  if (lower.startsWith("0xef0100") && lower.length === 48) {
    return "0x" + lower.slice(8);
  }
  return null;
}

const fmtList = (xs: string[] | undefined): string => (xs && xs.length ? [...xs].sort().join(",") : "—");

/** Diff one baseline snapshot against its current re-capture. Order: stable, most-critical first. */
export function diffSnapshots(base: AuthoritySnapshot, current: AuthoritySnapshot): Drift[] {
  const drifts: Drift[] = [];
  const at = { address: base.address, chain: base.chain, label: base.label };
  const push = (field: string, before: string, after: string): void => {
    if (before !== after) drifts.push({ ...at, field, before, after });
  };

  push("kind", base.kind, current.kind);
  push("codehash", base.codehash, current.codehash);
  push("owners", fmtList(base.owners), fmtList(current.owners));
  push("threshold", String(base.threshold ?? "—"), String(current.threshold ?? "—"));
  push("modules", fmtList(base.modules), fmtList(current.modules));
  push("minDelaySec", String(base.minDelaySec ?? "—"), String(current.minDelaySec ?? "—"));
  push("delegation", base.delegation ?? "—", current.delegation ?? "—");
  return drifts;
}

/** Diff a whole baseline file against fresh captures (matched by chain:address). */
export function diffBaselines(baseline: BaselineFile, current: AuthoritySnapshot[]): Drift[] {
  const byKey = new Map(current.map((s) => [snapshotKey(s), s]));
  const drifts: Drift[] = [];
  for (const base of baseline.snapshots) {
    const cur = byKey.get(snapshotKey(base));
    if (!cur) {
      drifts.push({
        address: base.address,
        chain: base.chain,
        label: base.label,
        field: "presence",
        before: "monitored",
        after: "not captured — address dropped from the watch set?",
      });
    } else {
      drifts.push(...diffSnapshots(base, cur));
    }
  }
  return drifts;
}

export type TransitionKind = "drift" | "recovered";

export interface AuthorityTransition {
  key: string;
  kind: TransitionKind;
  /** the drifts that opened, or [] on recovery. */
  drifts: Drift[];
}

/**
 * Alert-once transition tracking, mirroring the solvency `--watch` pattern:
 * a drift alerts the first time it is seen and stays silent while it persists;
 * a return to baseline emits one recovery. Iterates the union of previously
 * seen and currently reported keys, so a key that stops drifting (or drops
 * out of the report) resolves rather than going silent forever.
 */
export function computeAuthorityTransitions(
  prev: Map<string, boolean>,
  current: Map<string, Drift[]>,
): AuthorityTransition[] {
  const out: AuthorityTransition[] = [];
  const keys = new Set([...prev.keys(), ...current.keys()]);
  for (const key of keys) {
    const drifts = current.get(key) ?? [];
    const drifted = drifts.length > 0;
    const was = prev.get(key) ?? false;
    if (drifted && !was) out.push({ key, kind: "drift", drifts });
    else if (!drifted && was) out.push({ key, kind: "recovered", drifts: [] });
  }
  return out;
}

/** Parse + lightly validate a baseline file. Throws with a helpful message. */
export function parseBaselineFile(raw: string, source: string): BaselineFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source}: not valid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { snapshots?: unknown }).snapshots)
  ) {
    throw new Error(`${source}: expected { "version": 1, "snapshots": [...] }`);
  }
  const file = parsed as BaselineFile;
  for (const s of file.snapshots) {
    if (!s.address || !s.chain || !s.kind || !s.codehash) {
      throw new Error(
        `${source}: snapshot entry missing address/chain/kind/codehash: ${JSON.stringify(s).slice(0, 120)}`,
      );
    }
  }
  return file;
}

/** Merge snapshots into a baseline, deduping by chain:address (incoming wins). */
export function mergeSnapshots(existing: BaselineFile, incoming: AuthoritySnapshot[]): BaselineFile {
  const byKey = new Map(existing.snapshots.map((s) => [snapshotKey(s), s]));
  for (const s of incoming) byKey.set(snapshotKey(s), s);
  return { version: 1, snapshots: [...byKey.values()] };
}

const DRIFT_MARK = "🚨 DRIFT";
const OK_MARK = "✓ no drift";

function fmtDrift(d: Drift): string {
  return `    ${d.field.padEnd(12)} ${d.before}  →  ${d.after}`;
}

/** Human-readable check output: one block per monitored address. */
export function renderAuthorityHuman(baseline: BaselineFile, drifts: Drift[]): string {
  const byKey = new Map<string, Drift[]>();
  for (const d of drifts) {
    const key = `${d.chain}:${d.address.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(d);
  }
  const lines: string[] = ["", "  evmsec authority check", "  " + "─".repeat(30)];
  for (const s of baseline.snapshots) {
    const ds = byKey.get(snapshotKey(s)) ?? [];
    lines.push("");
    lines.push(`  ${s.label} — ${s.address} (${s.chain})`);
    if (ds.length === 0) {
      lines.push(`    ${OK_MARK} — kind=${s.kind}`);
    } else {
      lines.push(`    ${DRIFT_MARK} — ${ds.length} field(s) changed since ${s.capturedAt}`);
      for (const d of ds) lines.push(fmtDrift(d));
    }
  }
  const n = drifts.length;
  lines.push("");
  lines.push(
    n === 0
      ? "  OVERALL: ✓ no authority drift."
      : `  OVERALL: 🚨 ${n} drifted field(s) — investigate before trusting this authority.`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Machine-readable check output. */
export function renderAuthorityJson(baseline: BaselineFile, drifts: Drift[]): string {
  return JSON.stringify(
    {
      tool: "evmsec",
      command: "authority-check",
      overall: drifts.length === 0 ? "ok" : "drift",
      ok: drifts.length === 0,
      monitored: baseline.snapshots.length,
      driftedFields: drifts.length,
      drifts,
    },
    null,
    2,
  );
}
