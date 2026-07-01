import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LockLeg, Route } from "../bridges.js";
import { CHAINS, ChainKey } from "../config.js";
import { requireAddress } from "../lib.js";
import { Snapshot } from "./monitor.js";
import { Observation, Store, Watch } from "./storage.js";
import { exposureFor, ExposureRow } from "./exposure.js";
import { DASHBOARD_HTML } from "./ui.js";

/**
 * The Watchtower HTTP surface: REST + SSE + the embedded dashboard, on
 * node:http with no framework. Reads are open (the server binds loopback by
 * default); writes require the configured bearer token, or — when no token is
 * set — a loopback caller. See docs/watchtower.md §4 for the API contract.
 */

export interface ServerDeps {
  store: Store;
  snapshot(): Snapshot | null;
  lastSweep(): string | null;
  /** All routes currently swept (registry + watches) — for /api/routes & exposure. */
  routes(): Array<Route & { custom: boolean; notes?: string }>;
  /** Kick a sweep (fire-and-forget) so a new watch shows up quickly. */
  sweepNow(): void;
  token?: string;
  startedAt: number;
  exposure?: (address: string, routes: Route[], latest: Observation[]) => Promise<ExposureRow[]>;
}

/** Server-sent-events fan-out. One hub per process; every client gets every event. */
export class SseHub {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse, hello?: { event: string; data: unknown }): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": watchtower stream\n\n");
    if (hello) res.write(`event: ${hello.event}\ndata: ${JSON.stringify(hello.data)}\n\n`);
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Writes need the bearer token when one is set; otherwise a loopback caller. */
function writeAllowed(req: IncomingMessage, token: string | undefined): boolean {
  if (token) {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && tokensMatch(header.slice(7), token);
  }
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

interface WatchInput {
  bridge?: string;
  asset?: string;
  lock?: LockLeg | LockLeg[];
  mint?: { chain?: string; token?: string };
  minRatioPct?: number;
}

/** Validate a POST /api/watches body into a Watch payload; throws on bad input. */
export function parseWatchInput(raw: string): Omit<Watch, "id" | "createdAt"> {
  let input: WatchInput;
  try {
    input = JSON.parse(raw) as WatchInput;
  } catch (err) {
    throw new Error("body is not valid JSON", { cause: err });
  }
  const legs = Array.isArray(input.lock) ? input.lock : input.lock ? [input.lock] : [];
  if (!legs.length) throw new Error("lock leg(s) required: {chain, escrow, token}");
  const checkChain = (key: unknown): ChainKey => {
    if (typeof key !== "string" || !(key in CHAINS)) {
      throw new Error(`unknown chain "${String(key)}". Known: ${Object.keys(CHAINS).join(", ")}`);
    }
    return key as ChainKey;
  };
  const lock = legs.map((leg) => ({
    chain: checkChain(leg.chain),
    escrow: requireAddress(String(leg.escrow ?? ""), "escrow"),
    token: requireAddress(String(leg.token ?? ""), "lock token"),
  }));
  if (!input.mint) throw new Error("mint required: {chain, token}");
  const mint = {
    chain: checkChain(input.mint.chain),
    token: requireAddress(String(input.mint.token ?? ""), "mint token"),
  };
  const minRatioPct = input.minRatioPct ?? 100;
  if (typeof minRatioPct !== "number" || !Number.isFinite(minRatioPct) || minRatioPct <= 0 || minRatioPct > 1000) {
    throw new Error("minRatioPct must be a number in (0, 1000]");
  }
  return {
    bridge: typeof input.bridge === "string" && input.bridge.trim() ? input.bridge.trim().slice(0, 80) : "custom watch",
    asset: typeof input.asset === "string" && input.asset.trim() ? input.asset.trim().slice(0, 24) : "asset",
    lock: lock.length === 1 ? lock[0] : lock,
    mint,
    minRatioPct,
  };
}

export function createServer(deps: ServerDeps): { server: Server; sse: SseHub } {
  const sse = new SseHub();
  const exposure = deps.exposure ?? exposureFor;

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://watchtower.local");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (method === "GET" && path === "/api/health") {
      json(res, 200, {
        ok: true,
        uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
        lastSweepAt: deps.lastSweep(),
        sseClients: sse.size(),
      });
      return;
    }

    if (method === "GET" && path === "/api/status") {
      const snap = deps.snapshot();
      if (!snap) {
        json(res, 200, { generatedAt: null, overall: "pending", routes: [], total: 0 });
        return;
      }
      json(res, 200, snap);
      return;
    }

    if (method === "GET" && path === "/api/routes") {
      json(res, 200, deps.routes());
      return;
    }

    const history = path.match(/^\/api\/routes\/([^/]+)\/history$/);
    if (method === "GET" && history) {
      const limit = Math.min(500, Number(url.searchParams.get("limit")) || 100);
      json(res, 200, deps.store.history(decodeURIComponent(history[1]), limit));
      return;
    }

    if (method === "GET" && path === "/api/alerts") {
      const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
      json(res, 200, deps.store.alerts(limit));
      return;
    }

    if (method === "GET" && path === "/api/stream") {
      const snap = deps.snapshot();
      sse.add(res, snap ? { event: "status", data: snap } : undefined);
      return;
    }

    if (method === "GET" && path === "/api/exposure") {
      const address = url.searchParams.get("address") ?? "";
      let holder: string;
      try {
        holder = requireAddress(address, "address");
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : "bad address" });
        return;
      }
      json(res, 200, await exposure(holder, deps.routes(), deps.store.latest()));
      return;
    }

    if (path === "/api/watches" && method === "GET") {
      json(res, 200, deps.store.watches());
      return;
    }

    if (path === "/api/watches" && method === "POST") {
      if (!writeAllowed(req, deps.token)) {
        json(res, 401, { error: "writes require the bearer token (or a loopback caller when none is set)" });
        return;
      }
      let payload: Omit<Watch, "id" | "createdAt">;
      try {
        payload = parseWatchInput(await readBody(req));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : "invalid watch" });
        return;
      }
      const watch = deps.store.addWatch(payload);
      deps.sweepNow();
      json(res, 201, watch);
      return;
    }

    const watchId = path.match(/^\/api\/watches\/([^/]+)$/);
    if (watchId && method === "DELETE") {
      if (!writeAllowed(req, deps.token)) {
        json(res, 401, { error: "writes require the bearer token (or a loopback caller when none is set)" });
        return;
      }
      const removed = deps.store.removeWatch(decodeURIComponent(watchId[1]));
      if (!removed) {
        json(res, 404, { error: "unknown watch id" });
        return;
      }
      deps.sweepNow(); // rebuild the snapshot without the removed route
      json(res, 200, { removed: true });
      return;
    }

    if (path.startsWith("/api/")) {
      json(res, 404, { error: "not found" });
      return;
    }
    json(res, 404, { error: "not found — the dashboard lives at /" });
  }

  return { server, sse };
}
