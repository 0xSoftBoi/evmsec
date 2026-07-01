import { Check, CheckContext, CheckReport, report, verdictToSeverity } from "../check.js";
import { EtherscanSignal, MatchLevel, classifyVerification } from "../verification-core.js";

const DEFAULT_SOURCIFY = "https://sourcify.dev/server";
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

/**
 * Is the contract's source verified? A contract holding value whose source isn't
 * published anywhere can only be reviewed as raw bytecode — a yellow flag in its
 * own right, and the reason every other check here is working blind.
 *
 * Consults Sourcify first, then falls back to Etherscan (when an ETHERSCAN_API_KEY
 * is set) so a contract verified on only the explorer isn't flagged unverified.
 */
export const verificationCheck: Check = {
  id: "verification-status",
  title: "Source verification",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const base = ctx.opts.sourcify ?? DEFAULT_SOURCIFY;
    const { match, reachable } = await querySourcify(base, ctx.chain.chainId, ctx.target);

    // Only consult Etherscan when Sourcify didn't already confirm a match — no
    // point spending a second request (or an API-key call) on a settled verdict.
    const etherscan = match ? undefined : await queryEtherscan(ctx.chain.chainId, ctx.target);

    const verdict = classifyVerification({ match, reachable, etherscan });

    const evidence: Record<string, string> = {
      status: verdict.status,
      "verified by": verdict.provider,
      "sourcify match": match ?? "none",
    };
    if (etherscan) evidence["etherscan"] = etherscan;

    return report({
      id: this.id,
      title: this.title,
      severity: verdictToSeverity(verdict),
      summary: verdict.summary,
      evidence,
    });
  },
};

/** Query Sourcify v2. 200 → match level; 404 → not verified; anything else → unreachable. */
async function querySourcify(
  base: string,
  chainId: number,
  address: string,
): Promise<{ match: MatchLevel; reachable: boolean }> {
  const url = `${base.replace(/\/$/, "")}/v2/contract/${chainId}/${address}`;
  try {
    const res = await httpGet(url);
    if (res.status === 404) return { match: null, reachable: true };
    if (!res.ok) return { match: null, reachable: false };
    const body = (await res.json()) as { match?: MatchLevel };
    return { match: body.match ?? null, reachable: true };
  } catch {
    return { match: null, reachable: false };
  }
}

/**
 * Query Etherscan's multichain v2 API for source-verification status. Requires
 * ETHERSCAN_API_KEY (the v2 endpoint is key-gated); without one we return
 * `undefined` so the verdict rests on Sourcify alone rather than guessing.
 */
async function queryEtherscan(chainId: number, address: string): Promise<EtherscanSignal> {
  const key = process.env.ETHERSCAN_API_KEY?.trim();
  if (!key) return undefined;
  const url =
    `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=getsourcecode` + `&address=${address}&apikey=${key}`;
  try {
    const res = await httpGet(url);
    if (!res.ok) return "unreachable";
    const body = (await res.json()) as { status?: string; result?: Array<{ SourceCode?: string }> };
    // getsourcecode always returns a row; SourceCode is empty when unverified.
    const src = body.result?.[0]?.SourceCode ?? "";
    if (body.status === "1" && src.length > 0) return "verified";
    return "unverified";
  } catch {
    return "unreachable";
  }
}

/** GET with a bounded timeout (EVMSEC_HTTP_TIMEOUT_MS, default 12s). */
async function httpGet(url: string): Promise<Response> {
  const timeoutMs = Number(process.env.EVMSEC_HTTP_TIMEOUT_MS ?? 12000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
  } finally {
    clearTimeout(timer);
  }
}
