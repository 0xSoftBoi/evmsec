/**
 * GET /api/alerts — transitions need sweep-to-sweep state; this deployment is
 * per-request. Empty list keeps the UI honest (the alerts view explains quiet).
 * The GitHub-Actions bridge-status workflow provides unattended alerting.
 */
export default function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=3600");
  res.status(200).json([]);
}
