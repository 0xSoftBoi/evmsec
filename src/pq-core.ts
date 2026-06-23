import { getBytes, getAddress } from "ethers";

/**
 * Post-quantum readiness classification — pure logic, no network.
 *
 * The question behind the $57–135B "cryptographic migration debt": when a large
 * quantum computer can run Shor's algorithm, every signature scheme based on
 * elliptic-curve discrete log (ECDSA secp256k1, BLS/pairings on bn254 or
 * BLS12-381) is forgeable. A bridge whose attestation/message verification
 * rests on those is quantum-vulnerable; one built on lattice (ML-DSA) or
 * hash-based (Lamport/Merkle) signatures is not.
 *
 * We can't read intent from bytecode, but we CAN spot the cryptographic
 * primitives a verifier reaches for: which precompiles it calls, and which
 * signature-interface selectors it exposes. This is a heuristic indicator
 * scanner — honestly scoped. It reports what it found and a confidence; it is
 * not a proof. Always verify against the verifier's source.
 */

export type Scheme =
  | "eoa" // signer is an externally-owned account → ECDSA secp256k1
  | "ecdsa" // calls the ecrecover precompile
  | "bls-pairing" // calls a pairing / BLS precompile (bn254 or EIP-2537)
  | "sig-interface" // exposes a signature-verification interface, scheme unclear
  | "unknown";

// Note on PQ: we deliberately do NOT positively assert "post-quantum / safe" from
// bytecode. The EIP-8051 ML-DSA precompiles (0x12/0x13) and any custom PQ precompile
// addresses collide with extremely common constants (e.g. decimals = 18 = 0x12), so a
// positive PQ claim would be unreliable — and a false "safe" verdict is worse than none.
// The tool flags VULNERABLE or returns UNKNOWN; PQ-readiness is confirmed from source.

export interface SchemeVerdict {
  scheme: Scheme;
  /** true = Shor-breakable, false = PQ-secure, null = couldn't tell. */
  quantumVulnerable: boolean | null;
  confidence: "high" | "medium" | "low";
  indicators: string[];
}

// EVM opcodes we care about.
const PUSH1 = 0x60;
const PUSH4 = 0x63;
const PUSH32 = 0x7f;
const CALL = 0xf1;
const STATICCALL = 0xfa;
// Precompiles are invoked with CALL or STATICCALL only — never DELEGATECALL/CALLCODE
// (you can't delegatecall into a precompile). Excluding those avoids false positives on
// proxies, which delegatecall constantly and often push small constants nearby.
const CALL_OPS = new Set([CALL, STATICCALL]);

/** ERC-1271 and related signature-verification selectors (scheme-agnostic). */
const SELECTORS: Record<string, string> = {
  "1626ba7e": "ERC-1271 isValidSignature(bytes32,bytes)",
  "20c13b0b": "ERC-1271 isValidSignature(bytes,bytes) (legacy)",
};

/**
 * Scan deployed bytecode for precompile CALLs. Walks opcodes (correctly skipping
 * PUSH immediates so constants in data aren't mistaken for code), tracks the
 * small integers pushed in a sliding window, and when a CALL-family opcode is
 * hit records any windowed value that looks like a precompile address.
 *
 * Returns the set of precompile addresses observed near a call. Heuristic: the
 * address is one of several stack args, so we accept any recent small push —
 * this favors recall over precision, which is why callers attach a confidence.
 */
export function precompileCalls(bytecode: string): number[] {
  const code = bytecode && bytecode !== "0x" ? getBytes(bytecode) : new Uint8Array();
  const found = new Set<number>();
  const window: number[] = []; // recent small pushes (candidate addresses)
  const WINDOW = 10;

  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= PUSH1 && op <= PUSH32) {
      const n = op - PUSH1 + 1; // immediate length
      if (n <= 2) {
        let v = 0;
        for (let j = 1; j <= n && i + j < code.length; j++) v = (v << 8) | code[i + j];
        // Only the standardized precompile range we classify (ecrecover .. EIP-2537 BLS).
        // Capping here keeps large constants (memory offsets, 0x0101-style values) out of
        // the window so they can't be mistaken for precompile addresses.
        if (v >= 1 && v <= 0x11) {
          window.push(v);
          if (window.length > WINDOW) window.shift();
        }
      }
      i += n; // skip the immediate bytes
    } else if (CALL_OPS.has(op)) {
      for (const v of window) found.add(v);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Scan deployed bytecode for known signature-interface PUSH4 selectors. */
export function detectSelectors(bytecode: string): string[] {
  const code = bytecode && bytecode !== "0x" ? getBytes(bytecode) : new Uint8Array();
  const hits = new Set<string>();
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op === PUSH4) {
      let sel = "";
      for (let j = 1; j <= 4 && i + j < code.length; j++) sel += code[i + j].toString(16).padStart(2, "0");
      if (SELECTORS[sel]) hits.add(SELECTORS[sel]);
      i += 4;
    } else if (op >= PUSH1 && op <= PUSH32) {
      i += op - PUSH1 + 1;
    }
  }
  return [...hits];
}

/**
 * Classify the signature scheme a verifier relies on, and whether it is
 * quantum-vulnerable. Pure: pass deployed bytecode (and whether the target is an
 * EOA). Combines precompile-call and selector evidence into a verdict.
 */
export function classifyScheme(opts: { bytecode: string; isEoa?: boolean }): SchemeVerdict {
  if (opts.isEoa || !opts.bytecode || opts.bytecode === "0x") {
    return {
      scheme: "eoa",
      quantumVulnerable: true,
      confidence: "high",
      indicators: ["signer is an EOA → ECDSA secp256k1 key, forgeable under Shor"],
    };
  }

  // EIP-7702 delegated EOA: code is `0xef0100 || delegate(20 bytes)`. The account
  // is still controlled by the EOA's ECDSA key — quantum-vulnerable — and the
  // real execution logic lives at the delegate, which should be re-scanned.
  const lower = opts.bytecode.toLowerCase();
  if (lower.startsWith("0xef0100") && lower.length === 48) {
    const delegate = getAddress(`0x${lower.slice(8, 48)}`);
    return {
      scheme: "eoa",
      quantumVulnerable: true,
      confidence: "high",
      indicators: [
        `EIP-7702 delegated EOA → still controlled by an ECDSA secp256k1 key (Shor-breakable)`,
        `delegate code at ${delegate} — re-run pq-readiness on it for the execution logic`,
      ],
    };
  }

  const calls = precompileCalls(opts.bytecode);
  const indicators: string[] = [];
  let ecdsa = false;
  let bls = false;

  for (const a of calls) {
    const hex = `0x${a.toString(16).padStart(2, "0")}`;
    if (a === 0x01) {
      ecdsa = true;
      indicators.push(`calls ecrecover precompile (0x01) → ECDSA secp256k1 (Shor-breakable)`);
    } else if (a === 0x08) {
      bls = true;
      indicators.push(`calls bn254 pairing precompile (0x08) → pairing/BLS or SNARK over a Shor-breakable curve`);
    } else if (a >= 0x0b && a <= 0x11) {
      bls = true;
      indicators.push(`calls EIP-2537 BLS12-381 precompile (${hex}) → BLS signatures (Shor-breakable)`);
    }
  }

  for (const s of detectSelectors(opts.bytecode)) indicators.push(`exposes ${s}`);

  // A quantum-vulnerable indicator dominates. Otherwise we return UNKNOWN — never a
  // positive "safe" claim, which bytecode can't support (see the note on Scheme above).
  if (ecdsa || bls) {
    return {
      scheme: bls && !ecdsa ? "bls-pairing" : "ecdsa",
      quantumVulnerable: true,
      confidence: "medium", // precompile-call detection is heuristic
      indicators,
    };
  }
  if (indicators.length) {
    return { scheme: "sig-interface", quantumVulnerable: null, confidence: "low", indicators };
  }
  return {
    scheme: "unknown",
    quantumVulnerable: null,
    confidence: "low",
    indicators: ["no quantum-vulnerable primitive detected in bytecode — NOT a safety claim; confirm the scheme from source"],
  };
}
