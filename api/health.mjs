/** GET /api/health — liveness. lastSweepAt is null by design: sweeps are per-request here. */
export default function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ ok: true, mode: "serverless", lastSweepAt: null, sseClients: 0 });
}
