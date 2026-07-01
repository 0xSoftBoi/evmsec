/**
 * Compiler-bug exposure — pure logic, no network.
 *
 * Solidity ships with bugs, and the team publishes exactly which compiler
 * versions each one affects. A contract's deployed bytecode usually carries, in
 * its CBOR metadata trailer, the *exact solc version* it was built with — so
 * "was this compiled with a version subject to a known bug?" is a fully
 * deterministic, on-chain-readable question. evmsec's lane.
 *
 * This does two pure things: (1) extract the solc version from the metadata
 * trailer, and (2) match it against the bundled, Solidity-team-authored bug
 * lists. It is honest about the boundary: a bug being *present in the compiler
 * version* is necessary but not always sufficient — many bugs only bite under
 * specific compile settings (viaIR, optimizer, evmVersion) or code shapes. Those
 * `conditions` are surfaced, and a finding gated by them is "elevated, verify",
 * not a hard CI failure.
 */

import { SOLC_BUGS, SOLC_BUGS_BY_VERSION, SolcBug } from "./data/solc-bugs.js";

export interface SolcVersion {
  /** the normalized x.y.z release version, or null if it couldn't be read. */
  version: string | null;
  /** true when read from a release (3-byte) tag, false when from a prerelease/nightly string. */
  isRelease: boolean;
}

function hexToBytes(bytecode: string): number[] {
  const hex = bytecode.toLowerCase().replace(/^0x/, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/**
 * Extract the solc version from a contract's CBOR metadata trailer. Pure.
 *
 * The metadata format (https://docs.soliditylang.org/en/latest/metadata.html):
 * the last two bytes are the big-endian length of the preceding CBOR blob, which
 * contains a `"solc"` key. For releases the value is a 3-byte version
 * `[major, minor, patch]`; for nightlies it is a version string.
 */
export function extractSolcVersion(bytecode: string): SolcVersion {
  if (!bytecode || bytecode === "0x") return { version: null, isRelease: false };
  const bytes = hexToBytes(bytecode);
  if (bytes.length < 4) return { version: null, isRelease: false };

  // Bound the search to the CBOR trailer when the length suffix is sane; else
  // scan the whole tail (the "solc" key marker is specific enough).
  const cborLen = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  const region =
    cborLen > 0 && cborLen + 2 <= bytes.length ? bytes.slice(bytes.length - 2 - cborLen, bytes.length - 2) : bytes;

  // CBOR key "solc": 0x64 (text, len 4) + "solc" = 64 73 6f 6c 63
  const KEY = [0x64, 0x73, 0x6f, 0x6c, 0x63];
  for (let i = 0; i + KEY.length < region.length; i++) {
    if (KEY.every((b, k) => region[i + k] === b)) {
      const vi = i + KEY.length;
      const tag = region[vi];
      if (tag === 0x43 && vi + 3 < region.length) {
        // 3-byte byte string → release version
        const [maj, min, pat] = [region[vi + 1], region[vi + 2], region[vi + 3]];
        return { version: `${maj}.${min}.${pat}`, isRelease: true };
      }
      // text string (nightly/prerelease): 0x60..0x77 embed the length, 0x78 has a 1-byte length.
      let len = -1;
      let start = vi + 1;
      if (tag >= 0x60 && tag <= 0x77) len = tag - 0x60;
      else if (tag === 0x78) {
        len = region[vi + 1];
        start = vi + 2;
      }
      if (len > 0 && start + len <= region.length) {
        const str = String.fromCharCode(...region.slice(start, start + len));
        const m = str.match(/(\d+)\.(\d+)\.(\d+)/);
        if (m) return { version: `${m[1]}.${m[2]}.${m[3]}`, isRelease: false };
      }
    }
  }
  return { version: null, isRelease: false };
}

export type CompilerRisk = "critical" | "elevated" | "info";

export interface MatchedBug extends SolcBug {
  name: string;
  /** true when the bug bites only under specific compile settings we can't read from bytecode. */
  conditional: boolean;
}

export interface CompilerVerdict {
  version: string | null;
  /** false when the version isn't in the bundled table (older/newer than the snapshot). */
  knownVersion: boolean;
  bugs: MatchedBug[];
  risk: CompilerRisk;
  /** true when CI should fail: a serious bug applies unconditionally to this version. */
  fail: boolean;
  summary: string;
}

const SERIOUS = new Set(["high", "medium/high"]);
const MEDIUM = new Set(["medium", "low/medium"]);

/** Match a solc version against the bundled bug lists. Pure. */
export function classifyCompilerBugs(v: SolcVersion): CompilerVerdict {
  const version = v.version;
  if (!version) {
    return {
      version: null,
      knownVersion: false,
      bugs: [],
      risk: "info",
      fail: false,
      summary:
        "no solc version found in the bytecode metadata — the contract may strip metadata, be Vyper/assembly, or predate CBOR tags; can't assess compiler-bug exposure.",
    };
  }

  const names = SOLC_BUGS_BY_VERSION[version];
  if (names === undefined) {
    return {
      version,
      knownVersion: false,
      bugs: [],
      risk: "info",
      fail: false,
      summary: `solc ${version} is not in the bundled bug table (it may be older than 0.4.7 or newer than the snapshot) — re-generate the table or check the official list.`,
    };
  }

  const bugs: MatchedBug[] = names
    .map((name) => {
      const meta = SOLC_BUGS[name];
      return meta ? { name, ...meta, conditional: !!meta.conditions } : undefined;
    })
    .filter((b): b is MatchedBug => b !== undefined);

  if (bugs.length === 0) {
    return {
      version,
      knownVersion: true,
      bugs,
      risk: "info",
      fail: false,
      summary: `solc ${version} has no known bugs in the published list.`,
    };
  }

  const seriousUnconditional = bugs.filter((b) => SERIOUS.has(b.severity) && !b.conditional);
  const seriousConditional = bugs.filter((b) => SERIOUS.has(b.severity) && b.conditional);
  const medium = bugs.filter((b) => MEDIUM.has(b.severity));

  let risk: CompilerRisk;
  let fail = false;
  let summary: string;

  if (seriousUnconditional.length) {
    risk = "critical";
    fail = true;
    summary = `solc ${version} is subject to ${seriousUnconditional.length} high-severity bug(s) that apply unconditionally: ${seriousUnconditional
      .map((b) => b.name)
      .join(", ")}. Recompile on a fixed version.`;
  } else if (seriousConditional.length) {
    risk = "elevated";
    summary = `solc ${version} carries ${seriousConditional.length} high-severity bug(s) that only bite under specific compile settings (${seriousConditional
      .map((b) => b.name)
      .join(", ")}) — verify the contract's settings/code don't trigger them.`;
  } else if (medium.length) {
    risk = "elevated";
    summary = `solc ${version} carries ${medium.length} medium-severity bug(s) — review whether they apply.`;
  } else {
    risk = "info";
    summary = `solc ${version} has ${bugs.length} known low-severity bug(s); none high or medium.`;
  }

  return { version, knownVersion: true, bugs, risk, fail, summary };
}
