import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LockLeg, Route } from "../bridges.js";
import { ChainKey } from "../config.js";
import { SolvencyResult } from "../commands/solvency.js";

/**
 * Embedded persistence for `evmsec serve` — plain files under a data dir, no
 * database process. Everything the API reads is held in memory (bounded rings);
 * files exist so a restart resumes with history and doesn't re-alert
 * steady-state breaches. The hosted deployment swaps this for Postgres with the
 * same shapes (see docs/watchtower.md §3).
 *
 * Layout:
 *   <dataDir>/observations/<routeId>.jsonl   one line per sweep result
 *   <dataDir>/alerts.jsonl                   one line per breach/recovery
 *   <dataDir>/watches.json                   user-added routes (full rewrite)
 */

/** One sweep result for one route, timestamped. */
export type Observation = SolvencyResult & { at: string };

/** A breach/recovery transition, in the same shape `solvency --watch` webhooks POST. */
export type AlertEvent = SolvencyResult & { kind: "breach" | "recovery"; at: string };

/** A user-added route to include in every sweep. */
export interface Watch {
  id: string;
  bridge: string;
  asset: string;
  lock: LockLeg | LockLeg[];
  mint: { chain: ChainKey; token: string };
  minRatioPct: number;
  createdAt: string;
}

/** Convert a watch to the Route shape the solvency engine sweeps. */
export function watchToRoute(w: Watch): Route {
  return { id: w.id, bridge: w.bridge, asset: w.asset, lock: w.lock, mint: w.mint };
}

/** In-memory ring size per route (and what survives a compaction). */
const RING = 500;
/** Rewrite a route's jsonl from the ring once it grows past this many lines. */
const COMPACT_AT = 5_000;
/** Alerts kept in memory / returned by the API. */
const ALERTS_KEPT = 200;

/** Only safe-for-filename route ids touch disk verbatim; anything else is encoded. */
function fileNameFor(routeId: string): string {
  const safe = /^[a-zA-Z0-9._-]+$/.test(routeId) ? routeId : encodeURIComponent(routeId).replace(/%/g, "_");
  return `${safe}.jsonl`;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line from a crash mid-append is expected; skip it
    }
  }
  return out;
}

export class Store {
  private readonly obsDir: string;
  private readonly alertsPath: string;
  private readonly watchesPath: string;
  /** routeId → ring of recent observations (oldest first). */
  private readonly rings = new Map<string, Observation[]>();
  /** routeId → approximate lines in its jsonl (drives compaction). */
  private readonly lines = new Map<string, number>();
  private alertRing: AlertEvent[] = [];
  private watchList: Watch[] = [];

  constructor(dataDir: string) {
    this.obsDir = join(dataDir, "observations");
    this.alertsPath = join(dataDir, "alerts.jsonl");
    this.watchesPath = join(dataDir, "watches.json");
    mkdirSync(this.obsDir, { recursive: true });
    this.load();
  }

  private load(): void {
    for (const file of readdirSync(this.obsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const all = readJsonl<Observation>(join(this.obsDir, file));
      if (!all.length) continue;
      const ring = all.slice(-RING);
      this.rings.set(ring[ring.length - 1].id, ring);
      this.lines.set(ring[ring.length - 1].id, all.length);
    }
    this.alertRing = readJsonl<AlertEvent>(this.alertsPath).slice(-ALERTS_KEPT);
    if (existsSync(this.watchesPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.watchesPath, "utf8")) as { watches?: Watch[] };
        this.watchList = Array.isArray(parsed.watches) ? parsed.watches : [];
      } catch (err) {
        throw new Error(`corrupt watches file ${this.watchesPath} — fix or remove it`, { cause: err });
      }
    }
  }

  // ── observations ──────────────────────────────────────────────────────────

  appendObservation(obs: Observation): void {
    const ring = this.rings.get(obs.id) ?? [];
    ring.push(obs);
    if (ring.length > RING) ring.shift();
    this.rings.set(obs.id, ring);

    const path = join(this.obsDir, fileNameFor(obs.id));
    const count = (this.lines.get(obs.id) ?? 0) + 1;
    if (count > COMPACT_AT) {
      writeFileSync(path, ring.map((o) => JSON.stringify(o)).join("\n") + "\n");
      this.lines.set(obs.id, ring.length);
    } else {
      appendFileSync(path, JSON.stringify(obs) + "\n");
      this.lines.set(obs.id, count);
    }
  }

  /** Latest observation per route, sorted by route id for stable output. */
  latest(): Observation[] {
    return [...this.rings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ring]) => ring[ring.length - 1]);
  }

  /** Recent observations for one route, newest first. */
  history(routeId: string, limit = 100): Observation[] {
    const ring = this.rings.get(routeId) ?? [];
    return ring.slice(-Math.max(1, limit)).reverse();
  }

  /** Recent ratio values for one route, oldest first — sparkline fuel. */
  spark(routeId: string, points = 30): Array<number | null> {
    const ring = this.rings.get(routeId) ?? [];
    return ring.slice(-Math.max(1, points)).map((o) => o.ratioPct);
  }

  // ── alerts ────────────────────────────────────────────────────────────────

  appendAlert(alert: AlertEvent): void {
    this.alertRing.push(alert);
    if (this.alertRing.length > ALERTS_KEPT) this.alertRing.shift();
    appendFileSync(this.alertsPath, JSON.stringify(alert) + "\n");
  }

  /** Recent alerts, newest first. */
  alerts(limit = 50): AlertEvent[] {
    return this.alertRing.slice(-Math.max(1, limit)).reverse();
  }

  // ── watches ───────────────────────────────────────────────────────────────

  watches(): Watch[] {
    return [...this.watchList];
  }

  addWatch(input: Omit<Watch, "id" | "createdAt">): Watch {
    const watch: Watch = { ...input, id: `watch-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString() };
    this.watchList.push(watch);
    this.persistWatches();
    return watch;
  }

  removeWatch(id: string): boolean {
    const before = this.watchList.length;
    this.watchList = this.watchList.filter((w) => w.id !== id);
    if (this.watchList.length === before) return false;
    this.persistWatches();
    // Drop the watch's observations too — otherwise its last result would sit
    // on the board as a ghost row forever (and reappear after restarts).
    this.rings.delete(id);
    this.lines.delete(id);
    rmSync(join(this.obsDir, fileNameFor(id)), { force: true });
    return true;
  }

  private persistWatches(): void {
    writeFileSync(this.watchesPath, JSON.stringify({ watches: this.watchList }, null, 2) + "\n");
  }
}
