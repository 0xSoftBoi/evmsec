import { Check, CheckContext, CheckReport, report, verdictToSeverity } from "../check.js";
import { withRetry } from "../lib.js";
import { classifyCompilerBugs, extractSolcVersion } from "../compiler-core.js";
import { resolveImplementation } from "./onchain.js";

/**
 * Was this contract built with a solc version subject to a known compiler bug?
 * The version is read from the bytecode's CBOR metadata trailer and matched
 * against the Solidity team's own published bug lists — deterministic and citable.
 */
export const compilerBugsCheck: Check = {
  id: "compiler-bugs",
  title: "Compiler bugs",
  applies: (ctx) => ctx.code !== "0x",

  async assess(ctx: CheckContext): Promise<CheckReport> {
    const { provider, target, code } = ctx;
    // The implementation's metadata is what matters — follow the proxy if present.
    const implementation = await resolveImplementation(provider, target);
    const scanned = implementation
      ? await withRetry(() => provider.getCode(implementation), { label: "impl getCode" })
      : code;

    const solc = extractSolcVersion(scanned);
    const verdict = classifyCompilerBugs(solc);

    const evidence: CheckReport["evidence"] = { "solc version": verdict.version ?? "not found in metadata" };
    if (implementation) evidence.implementation = implementation;

    // Only surface the bugs that drive the verdict (medium and above); collapse the
    // long tail of low/very-low bugs into a single count so the output stays sharp.
    const isMinor = (s: string) => s === "low" || s === "very low";
    const shown = verdict.bugs.filter((b) => !isMinor(b.severity));
    const minor = verdict.bugs.length - shown.length;
    const notes = shown.map(
      (b) =>
        `[${b.severity}] ${b.name}${b.conditional ? " (conditional — verify compile settings)" : ""}${b.link ? ` — ${b.link}` : ""}`,
    );
    if (minor > 0) notes.push(`+${minor} low/very-low bug(s) in this version (see the official list).`);

    return report({
      id: this.id,
      title: this.title,
      severity: verdictToSeverity(verdict),
      summary: verdict.summary,
      evidence,
      notes,
    });
  },
};
