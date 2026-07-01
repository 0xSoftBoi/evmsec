import { sendError } from "./_engine.mjs";

/**
 * /api/watches — watches need persistent state, which this read-only serverless
 * deployment doesn't have. GET returns an empty list so the UI renders; writes
 * explain where the feature lives.
 */
export default function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    res.status(200).json([]);
    return;
  }
  sendError(
    res,
    501,
    "this is a read-only serverless deployment — watches need persistent state. " +
      "Run `evmsec serve` locally (or the hosted build) to add custom routes.",
  );
}
