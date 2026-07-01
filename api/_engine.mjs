/**
 * Shared loader for the Vercel serverless functions (underscore-prefixed files
 * are importable but not deployed as endpoints). Everything comes from the
 * built dist/ — the same engine as `evmsec serve`, minus the long-lived parts
 * (monitor loop, SSE, file storage) that a serverless platform can't host.
 *
 * Concurrency is raised before the engine loads (the module reads the env at
 * import time): a serverless sweep must fit one request's time budget.
 */
process.env.EVMSEC_CONCURRENCY ||= "11";

export async function engine() {
  const [solvency, bridges, monitor, lib, exposure] = await Promise.all([
    import("../dist/commands/solvency.js"),
    import("../dist/bridges.js"),
    import("../dist/serve/monitor.js"),
    import("../dist/lib.js"),
    import("../dist/serve/exposure.js"),
  ]);
  return {
    checkAll: solvency.checkAll,
    loadRoutes: bridges.loadRoutes,
    findRoute: bridges.findRoute,
    buildSnapshot: monitor.buildSnapshot,
    requireAddress: lib.requireAddress,
    exposureFor: exposure.exposureFor,
  };
}

/** The CDN does the heavy lifting: cached five minutes, stale served while revalidating. */
export const SNAPSHOT_CACHE = "public, s-maxage=300, stale-while-revalidate=3600";

export function sendError(res, status, message) {
  res.status(status).json({ error: message });
}
