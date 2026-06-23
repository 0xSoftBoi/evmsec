import { chain } from "../config.js";
import { addrLink, getProvider, requireAddress } from "../lib.js";
import { classifyScheme, SchemeVerdict } from "../pq-core.js";

/**
 * `evmsec pq-readiness <address> [--chain ethereum] [--json]`
 *
 * Is this verifier (a bridge's signature/attestation gate, a multisig, a token
 * admin) post-quantum ready, or is it Shor-breakable? Classifies the signature
 * primitive it reaches for from its deployed bytecode — ECDSA (ecrecover),
 * BLS/pairings (bn254, EIP-2537), or a custom PQ precompile (e.g. ML-DSA).
 *
 * Of the named institutional digital-asset programs, ~0 have a disclosed PQ
 * roadmap. This surfaces the migration debt in one command. Heuristic, honestly
 * scoped — it reports indicators + a confidence, not a proof.
 *
 * Exit code is non-zero when quantum-vulnerable, so it drops into CI like
 * `solvency`.
 */
export async function pqReadiness(args: string[]): Promise<void> {
  const { address, chainKey, json } = parse(args);
  if (!address) throw new Error("usage: evmsec pq-readiness <address> [--chain ethereum] [--json]");

  const c = chain(chainKey);
  const provider = getProvider(c);
  const target = requireAddress(address);

  const code = await provider.getCode(target);
  const isEoa = code === "0x";
  const verdict = classifyScheme({ bytecode: code, isEoa });

  if (json) {
    console.log(JSON.stringify({ address: target, chain: c.key, ...verdict }, null, 2));
  } else {
    print(c.name, target, addrLink(c, target), verdict);
  }

  if (verdict.quantumVulnerable === true) process.exitCode = 1;
}

const LABEL: Record<SchemeVerdict["scheme"], string> = {
  eoa: "EOA signer (ECDSA secp256k1)",
  ecdsa: "ECDSA (ecrecover)",
  "bls-pairing": "BLS / pairing-based",
  "sig-interface": "signature interface, scheme unclear",
  unknown: "no vulnerable primitive detected (not a safety claim)",
};

function print(chainName: string, target: string, link: string, v: SchemeVerdict): void {
  const verdict =
    v.quantumVulnerable === true
      ? "⚠ QUANTUM-VULNERABLE — Shor-breakable signatures"
      : v.quantumVulnerable === false
        ? "✓ post-quantum primitive detected"
        : "? indeterminate — verify the source";

  console.log(`\nPQ-readiness — ${target} on ${chainName}`);
  console.log("─".repeat(64));
  console.log(`  scheme          ${LABEL[v.scheme]}`);
  console.log(`  verdict         ${verdict}`);
  console.log(`  confidence      ${v.confidence}`);
  console.log(`  ${link}`);
  console.log(`\n  indicators`);
  for (const ind of v.indicators) console.log(`    • ${ind}`);
  console.log(
    `\n  Heuristic from bytecode — not a proof. ECDSA/BLS rest on elliptic-curve`,
  );
  console.log(`  discrete log, forgeable once Shor-capable quantum computers exist.`);
  console.log(`  Verify against the verifier's source before acting.\n`);
}

function parse(args: string[]): { address?: string; chainKey: string; json: boolean } {
  let address: string | undefined;
  let chainKey = "ethereum";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chain" || args[i] === "-c") chainKey = args[++i];
    else if (args[i] === "--json") json = true;
    else if (!address) address = args[i];
  }
  return { address, chainKey, json };
}
