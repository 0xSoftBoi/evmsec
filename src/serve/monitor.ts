import { Route } from "../bridges.js";
import { SolvencyResult } from "../commands/solvency.js";
import { computeTransitions, isRouteFailing } from "../solvency-core.js";
import { AlertEvent, Observation } from "./storage.js";

/**
 * The sweep loop behind `evmsec serve`: run the solvency engine over the
 * registry + user watches on an interval, persist observations, derive
 * breach/recovery transitions (same pure core as `solvency --watch`, so the
 * dashboard and the CLI cannot drift apart), and fan alerts out to SSE
 * subscribers and an optional webhook.
 *
 * Everything the loop touches arrives injected, so the whole lifecycle is
 * unit-tested with a fake checker — no network, no timers.
 */

export interface Snapshot {
  generatedAt: string;
  overall: "backed" | "undercollateralized" | "degraded";
  backed: number;
  breached: number;
  errored: number;
  total: number;
  totalLockedUsd: number | null;
  routes: Array<Observation & { spark: Array<number | null> }>;
}

/** Roll latest observations into the STATUS.json-shaped snapshot the API serves. */
export function buildSnapshot(latest: Observation[], spark: (routeId: string) => Array<number | null>): Snapshot {
  const backed = latest.filter((r) => r.verdict === "BACKED").length;
  const breached = latest.filter((r) => r.verdict === "UNDERCOLLATERALIZED").length;
  const errored = latest.filter((r) => r.verdict === "ERROR").length;
  const totalLockedUsd = latest.reduce((sum, r) => sum + (typeof r.lockedUsd === "number" ? r.lockedUsd : 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    overall: breached ? "undercollateralized" : errored ? "degraded" : "backed",
    backed,
    breached,
    errored,
    total: latest.length,
    totalLockedUsd: totalLockedUsd > 0 ? Math.round(totalLockedUsd) : null,
    routes: latest.map((r) => ({ ...r, spark: spark(r.id) })),
  };
}

/** The slice of Store the monitor needs (Store satisfies it; tests fake it). */
export interface MonitorStore {
  appendObservation(obs: Observation): void;
  appendAlert(alert: AlertEvent): void;
  latest(): Observation[];
  spark(routeId: string, points?: number): Array<number | null>;
}

export interface MonitorDeps {
  /** Routes to sweep — re-read each sweep so new watches join without restart. */
  routes(): Route[];
  /** The solvency engine (checkAll in production; a stub in tests). */
  check(routes: Route[]): Promise<SolvencyResult[]>;
  store: MonitorStore;
  /** SSE fan-out; called with ("status", Snapshot) and ("alert", AlertEvent). */
  broadcast(event: string, data: unknown): void;
  intervalMs: number;
  /** Failing threshold for a route (per-watch min-ratio or the global default). */
  minRatioFor(routeId: string): number;
  webhookUrl?: string;
  fetchFn?: typeof fetch;
  log?(message: string): void;
}

export class Monitor {
  private readonly failing = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  private rerun = false;
  private last: Snapshot | null = null;
  private lastSweepAt: string | null = null;

  constructor(private readonly deps: MonitorDeps) {
    // Seed transition state from persisted history so a restart does not
    // re-alert a breach that was already known before the process died.
    for (const obs of deps.store.latest()) {
      this.failing.set(obs.id, isRouteFailing(obs, deps.minRatioFor(obs.id)));
    }
  }

  snapshot(): Snapshot | null {
    return this.last;
  }

  lastSweep(): string | null {
    return this.lastSweepAt;
  }

  /** One full sweep. Exposed for tests and for "sweep now" after a watch change. */
  async sweep(): Promise<Snapshot | null> {
    if (this.sweeping) {
      // Never overlap slow RPC sweeps — but don't drop the request either: a
      // watch added mid-sweep must not wait a whole interval to appear.
      this.rerun = true;
      return this.last;
    }
    this.sweeping = true;
    try {
      const results = await this.deps.check(this.deps.routes());
      const at = new Date().toISOString();

      for (const r of results) this.deps.store.appendObservation({ ...r, at });

      const current = results.map((r) => ({ id: r.id, failing: isRouteFailing(r, this.deps.minRatioFor(r.id)) }));
      const transitions = computeTransitions(this.failing, current);
      for (const c of current) this.failing.set(c.id, c.failing);

      const byId = new Map(results.map((r) => [r.id, r]));
      for (const t of transitions) {
        const r = byId.get(t.id);
        if (!r) continue;
        const alert: AlertEvent = { ...r, kind: t.kind, at };
        this.deps.store.appendAlert(alert);
        this.deps.broadcast("alert", alert);
        await this.postWebhook(alert);
      }

      this.last = buildSnapshot(this.deps.store.latest(), (id) => this.deps.store.spark(id));
      this.lastSweepAt = at;
      this.deps.broadcast("status", this.last);
      return this.last;
    } catch (err) {
      this.deps.log?.(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.last;
    } finally {
      this.sweeping = false;
      if (this.rerun) {
        this.rerun = false;
        void this.sweep();
      }
    }
  }

  /** Same webhook body as `solvency --watch --webhook`, so consumers share one schema. */
  private async postWebhook(alert: AlertEvent): Promise<void> {
    if (!this.deps.webhookUrl) return;
    const doFetch = this.deps.fetchFn ?? fetch;
    try {
      await doFetch(this.deps.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: alert.kind, ...alert }),
      });
    } catch (err) {
      this.deps.log?.(`webhook POST failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.deps.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
