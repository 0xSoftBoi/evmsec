import { ChainConfig, chain } from "../config.js";
import { addrLink, getProvider, requireAddress, withRetry } from "../lib.js";
import { MatchLevel, VerificationVerdict, classifyVerification } from "../verification-core.js";

/**
 * `evmsec verification-status <address> [--chain ethereum] [--sourcify <url>] [--json]`
 *
 * Is this contract's source verified? Queries Sourcify v2
 * (`GET /v2/contract/{chainId}/{address}`) and classifies the result as a full
 * (exact) match, a partial match, or unverified. Exits non-zero when no verified
 * source is found — an unverified contract holding value can only be reviewed as
 * raw bytecode.
 */
const DEFAULT_SOURCIFY = "https://sourcify.dev/server";

export async function verificationStatus(args: string[]): Promise<void> {
  const { address, chainKey, sourcify, json } = parse(args);
  if (!address)
    throw new Error("usage: evmsec verification-status <address> [--chain ethereum] [--sourcify <url>] [--json]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  // A no-code address has nothing to verify — say so plainly.
  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  if (code === "0x") {
    const msg = `${target} on ${c.name} has no code (EOA or self-destructed) — there is no contract source to verify.`;
    if (json) console.log(JSON.stringify({ address: target, chain: c.key, error: "no code at address" }, null, 2));
    else console.log(`\n${msg}\n`);
    process.exitCode = 1;
    return;
  }

  const { match, reachable } = await querySourcify(sourcify, c.chainId, target);
  const verdict = classifyVerification({ match, reachable });

  if (json) {
    console.log(
      JSON.stringify(
        {
          address: target,
          chain: c.key,
          chainId: c.chainId,
          match,
          status: verdict.status,
          risk: verdict.risk,
          summary: verdict.summary,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, target, match, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
}

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

const RISK_MARK: Record<string, string> = { critical: "✗ CRITICAL", elevated: "⚠ ELEVATED", info: "· INFO" };
const STATUS_LABEL: Record<VerificationVerdict["status"], string> = {
  exact: "verified (exact match)",
  partial: "verified (partial match)",
  unverified: "UNVERIFIED",
  unknown: "unknown (provider unreachable)",
};

function print(c: ChainConfig, target: string, match: MatchLevel, v: VerificationVerdict): void {
  console.log(`\nVerification-status — ${target} on ${c.name}`);
  console.log("─".repeat(68));
  console.log(`  address         ${target}\n                  ${addrLink(c, target)}`);
  console.log(`  source          ${STATUS_LABEL[v.status]}`);
  if (match) console.log(`  sourcify match  ${match}`);
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  console.log(`\n  ${v.summary}`);
  console.log(`\n  Source via Sourcify; a block explorer may verify it independently.\n`);
}

function parse(args: string[]): { address?: string; chainKey: string; sourcify: string; json: boolean } {
  let address: string | undefined;
  let chainKey = "ethereum";
  let sourcify = DEFAULT_SOURCIFY;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error("--chain requires a value (e.g. --chain ethereum)");
      chainKey = args[++i];
    } else if (args[i] === "--sourcify") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--sourcify requires a server URL");
      sourcify = args[++i];
    } else if (args[i] === "--json") json = true;
    else if (!address) address = args[i];
  }
  return { address, chainKey, sourcify, json };
}
