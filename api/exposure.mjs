import { engine, sendError } from "./_engine.mjs";

/**
 * GET /api/exposure?address=0x… — wrapped-token balances across the registry.
 * Route verdicts come from this deployment's own CDN-cached /api/status (cheap
 * when warm); if that read fails, balances still return, just without verdicts.
 */
export default async function handler(req, res) {
  const { exposureFor, loadRoutes, requireAddress } = await engine();

  let holder;
  try {
    holder = requireAddress(String(req.query.address ?? ""), "address");
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "bad address");
    return;
  }

  let latest = [];
  try {
    const proto = req.headers["x-forwarded-proto"] ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const status = await fetch(`${proto}://${host}/api/status`);
    if (status.ok) latest = (await status.json()).routes ?? [];
  } catch {
    // verdict column degrades gracefully; balances are the point
  }

  res.setHeader("cache-control", "no-store"); // balances are per-address, never shared-cache them
  res.status(200).json(await exposureFor(holder, loadRoutes(), latest));
}
