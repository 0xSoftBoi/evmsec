import { resolve } from "node:path";
import { Route, loadRoutes } from "../bridges.js";
import { checkAll } from "./solvency.js";
import { Monitor } from "../serve/monitor.js";
import { createServer } from "../serve/server.js";
import { Store, watchToRoute } from "../serve/storage.js";

/**
 * `evmsec serve` — the Watchtower: an embedded web app (dashboard + REST/SSE
 * API + background monitor) over the same solvency engine as the CLI. Binds
 * loopback by default; expose it (--host 0.0.0.0) and writes require --token.
 * See docs/watchtower.md for the full product design.
 */
export async function serve(args: string[]): Promise<void> {
  const opts = parse(args);
  const store = new Store(opts.dataDir);
  const startedAt = Date.now();

  // Registry + user watches, re-read every sweep so new watches join live.
  const watchMinRatios = (): Map<string, number> => new Map(store.watches().map((w) => [w.id, w.minRatioPct]));
  const sweepRoutes = (): Route[] => [...loadRoutes(), ...store.watches().map(watchToRoute)];

  const monitor = new Monitor({
    routes: sweepRoutes,
    check: checkAll,
    store,
    broadcast: (event, data) => sse.broadcast(event, data),
    intervalMs: opts.intervalSec * 1000,
    minRatioFor: (id) => watchMinRatios().get(id) ?? opts.minRatio,
    webhookUrl: opts.webhook,
    log: (msg) => console.error(`[watchtower] ${msg}`),
  });

  const { server, sse } = createServer({
    store,
    snapshot: () => monitor.snapshot(),
    lastSweep: () => monitor.lastSweep(),
    routes: () => [
      ...loadRoutes().map((r) => ({ ...r, custom: false })),
      ...store.watches().map((w) => ({ ...watchToRoute(w), custom: true })),
    ],
    sweepNow: () => void monitor.sweep(),
    token: opts.token,
    startedAt,
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(opts.port, opts.host, () => resolveListen());
  });

  const shownHost = opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  console.error(`watchtower listening on http://${shownHost}:${opts.port}  (host ${opts.host})`);
  console.error(
    `  sweeping ${sweepRoutes().length} route(s) every ${opts.intervalSec}s · data in ${opts.dataDir}` +
      `${opts.webhook ? " · webhook on" : ""}${opts.token ? " · writes token-gated" : " · writes loopback-only"}`,
  );
  if (opts.host !== "127.0.0.1" && !opts.token) {
    console.error("  ⚠ exposed beyond loopback without --token — the API is read-only for non-loopback callers.");
  }

  monitor.start();

  await new Promise<void>((resolveSignal) => {
    const stop = (): void => {
      console.error("\nshutting down…");
      monitor.stop();
      sse.closeAll();
      server.close(() => resolveSignal());
      // A lingering keep-alive socket must not block exit.
      setTimeout(resolveSignal, 2_000).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

interface Opts {
  port: number;
  host: string;
  intervalSec: number;
  minRatio: number;
  dataDir: string;
  token?: string;
  webhook?: string;
}

function parse(args: string[]): Opts {
  const opts: Opts = {
    port: 8787,
    host: "127.0.0.1",
    intervalSec: 60,
    minRatio: 100,
    dataDir: resolve(".evmsec-serve"),
    token: process.env.EVMSEC_TOKEN?.trim() || undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        opts.port = Number(args[++i]);
        break;
      case "--host":
        opts.host = args[++i];
        break;
      case "--interval":
        opts.intervalSec = Math.max(5, Number(args[++i]) || 60);
        break;
      case "--min-ratio":
        opts.minRatio = Number(args[++i]) || 100;
        break;
      case "--data-dir":
        opts.dataDir = resolve(args[++i]);
        break;
      case "--token":
        opts.token = args[++i];
        break;
      case "--webhook":
        opts.webhook = args[++i];
        break;
      default:
        throw new Error(
          `unknown flag "${args[i]}". usage: evmsec serve [--port 8787] [--host 127.0.0.1] ` +
            `[--interval 60] [--min-ratio 100] [--data-dir .evmsec-serve] [--token …] [--webhook URL]`,
        );
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`invalid --port ${opts.port}`);
  }
  return opts;
}
