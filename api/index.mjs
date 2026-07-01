/** GET / — the same zero-build dashboard `evmsec serve` ships (SSE falls back to polling here). */
export default async function handler(req, res) {
  const { DASHBOARD_HTML } = await import("../dist/serve/ui.js");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  );
  res.status(200).send(DASHBOARD_HTML);
}
