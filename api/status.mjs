import { engine, SNAPSHOT_CACHE } from "./_engine.mjs";

/**
 * GET /api/status — the live snapshot, computed on demand and cached at the
 * CDN (s-maxage + stale-while-revalidate), so most visitors get an instant
 * cached board and the sweep only actually runs when the cache goes stale.
 * Same response shape as `evmsec serve`; spark is empty (no persistence here).
 */
export default async function handler(req, res) {
  const { checkAll, loadRoutes, buildSnapshot } = await engine();
  const results = await checkAll(loadRoutes());
  const at = new Date().toISOString();
  const snapshot = buildSnapshot(
    results.map((r) => ({ ...r, at })),
    () => [],
  );
  res.setHeader("cache-control", SNAPSHOT_CACHE);
  res.status(200).json(snapshot);
}
