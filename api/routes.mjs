import { engine, SNAPSHOT_CACHE } from "./_engine.mjs";

/** GET /api/routes — the bundled verified registry (no user watches on this deployment). */
export default async function handler(req, res) {
  const { loadRoutes } = await engine();
  res.setHeader("cache-control", SNAPSHOT_CACHE);
  res.status(200).json(loadRoutes().map((r) => ({ ...r, custom: false })));
}
