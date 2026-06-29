import { ChainConfig, chain } from "../config.js";
import { EIP1967, ZEPPELINOS, addrLink, addressFromSlot, getProvider, requireAddress, withRetry } from "../lib.js";
import { CompilerVerdict, classifyCompilerBugs, extractSolcVersion } from "../compiler-core.js";

/**
 * `evmsec compiler-bugs <address> [--chain ethereum] [--json]`
 *
 * Was this contract compiled with a solc version subject to a known compiler
 * bug? Reads the exact solc version from the bytecode's CBOR metadata trailer
 * and matches it against the Solidity team's own published bug lists. For
 * proxies it follows the implementation (that's where the logic — and its
 * compiler — lives). Exits non-zero when a high-severity bug applies
 * unconditionally to that version.
 *
 * Deterministic and citable: every finding links to the official writeup. Honest
 * about the boundary — a bug present in the compiler version is necessary but
 * not always sufficient; condition-gated bugs read "elevated, verify".
 */
export async function compilerBugs(args: string[]): Promise<void> {
  const { address, chainKey, json } = parse(args);
  if (!address) throw new Error("usage: evmsec compiler-bugs <address> [--chain ethereum] [--json]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  const code = await withRetry(() => provider.getCode(target), { label: "getCode" });
  if (code === "0x") {
    const msg = `${target} on ${c.name} has no code (EOA or self-destructed) — nothing to analyze.`;
    if (json) console.log(JSON.stringify({ address: target, chain: c.key, error: "no code at address" }, null, 2));
    else console.log(`\n${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // The implementation's metadata is what matters — follow the proxy if present.
  const implementation = await resolveImplementation(provider, target);
  const scanned = implementation
    ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
    : code;

  const solc = extractSolcVersion(scanned);
  const verdict = classifyCompilerBugs(solc);

  if (json) {
    console.log(
      JSON.stringify(
        {
          address: target,
          chain: c.key,
          implementation,
          solcVersion: verdict.version,
          isRelease: solc.isRelease,
          knownVersion: verdict.knownVersion,
          risk: verdict.risk,
          bugs: verdict.bugs.map((b) => ({
            uid: b.uid,
            name: b.name,
            severity: b.severity,
            conditional: b.conditional,
            link: b.link ?? null,
          })),
          summary: verdict.summary,
        },
        null,
        2,
      ),
    );
  } else {
    print(c, target, implementation, verdict);
  }

  if (verdict.fail) process.exitCode = 1;
}

async function resolveImplementation(provider: ReturnType<typeof getProvider>, target: string): Promise<string | null> {
  const [implWord, legacyWord] = await Promise.all([
    withRetry(() => provider.getStorage(target, EIP1967.implementation), { label: "impl slot" }),
    withRetry(() => provider.getStorage(target, ZEPPELINOS.implementation), { label: "legacy impl slot" }),
  ]);
  return addressFromSlot(implWord) ?? addressFromSlot(legacyWord);
}

const RISK_MARK: Record<string, string> = { critical: "✗ CRITICAL", elevated: "⚠ ELEVATED", info: "· INFO" };

function print(c: ChainConfig, target: string, implementation: string | null, v: CompilerVerdict): void {
  console.log(`\nCompiler-bugs — ${target} on ${c.name}`);
  console.log("─".repeat(68));
  if (implementation)
    console.log(
      `  proxy           yes — analyzed implementation ${implementation}\n                  ${addrLink(c, implementation)}`,
    );
  console.log(`  solc version    ${v.version ?? "not found in metadata"}`);
  console.log(`  risk            ${RISK_MARK[v.risk] ?? v.risk}`);
  if (v.bugs.length) {
    console.log(`\n  known bugs in this version:`);
    for (const b of v.bugs) {
      const gate = b.conditional ? " (conditional — verify compile settings)" : "";
      console.log(`    [${b.severity}] ${b.name}${gate}`);
      console.log(`        ${b.summary}`);
      if (b.link) console.log(`        ${b.link}`);
    }
  }
  console.log(`\n  ${v.summary}`);
  if (implementation) console.log(`\n  (Compiler of the implementation; the proxy stub may use a different version.)`);
  console.log("");
}

function parse(args: string[]): { address?: string; chainKey: string; json: boolean } {
  let address: string | undefined;
  let chainKey = "ethereum";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error("--chain requires a value (e.g. --chain ethereum)");
      chainKey = args[++i];
    } else if (args[i] === "--json") json = true;
    else if (!address) address = args[i];
  }
  return { address, chainKey, json };
}
