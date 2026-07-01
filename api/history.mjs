import { engine, SNAPSHOT_CACHE, sendError } from "./_engine.mjs";

/**
 * GET /api/routes/:id/history (rewritten to /api/history?id=…) — serverless has
 * no stored history, so this returns a single fresh observation for the route:
 * the detail page shows live state instead of an empty chart.
 */
export default async function handler(req, res) {
  const id = String(req.query.id ?? "");
  const { checkAll, findRoute } = await engine();
  let route;
  try {
    route = findRoute(id);
  } catch {
    sendError(res, 404, `unknown route "${id}"`);
    return;
  }
  const [result] = await checkAll([route]);
  res.setHeader("cache-control", SNAPSHOT_CACHE);
  res.status(200).json([{ ...result, at: new Date().toISOString() }]);
}
