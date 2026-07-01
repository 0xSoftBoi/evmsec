import { Check, CheckContext, CheckReport, report, verdictToSeverity } from "../check.js";
import { MatchLevel, classifyVerification } from "../verification-core.js";

const DEFAULT_SOURCIFY = "https://sourcify.dev/server";

/**
 * Is the contract's source verified? A contract holding value whose source isn't
 * published anywhere can only be reviewed as raw bytecode — a yellow flag in its
 * own right, and the reason every other check here is working blind.
 */
export const verificationCheck: Check = {
  id: "verification-status",
  title: "Source verification",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const base = ctx.opts.sourcify ?? DEFAULT_SOURCIFY;
    const { match, reachable } = await querySourcify(base, ctx.chain.chainId, ctx.target);
    const verdict = classifyVerification({ match, reachable });

    return report({
      id: this.id,
      title: this.title,
      severity: verdictToSeverity(verdict),
      summary: verdict.summary,
      evidence: { status: verdict.status, "sourcify match": match ?? "none" },
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
  const timeoutMs = Number(process.env.EVMSEC_HTTP_TIMEOUT_MS ?? 12000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (res.status === 404) return { match: null, reachable: true };
    if (!res.ok) return { match: null, reachable: false };
    const body = (await res.json()) as { match?: MatchLevel };
    return { match: body.match ?? null, reachable: true };
  } catch {
    return { match: null, reachable: false };
  } finally {
    clearTimeout(timer);
  }
}
