# Cryptographic migration-debt audit — methodology

A repeatable methodology for assessing a protocol's **post-quantum migration debt**: where
does it rely on signatures that a Shor-capable quantum computer can forge, and what is the
remediation path? `evmsec pq-readiness` is the triage tool; this doc is the rubric around it.

> Offered as a paid engagement by **Zero 1 Labs**. This methodology is open so findings are
> reproducible and the tool's limits are stated up front.

## Why this exists

ECDSA secp256k1, BLS, and pairing-based signatures all rest on the elliptic-curve discrete-log
problem, which Shor's algorithm breaks. There is an estimated **$57–135B** of "cryptographic
migration debt" across institutional digital-asset programs, and of the named programs ~**0**
have a disclosed PQ roadmap. NIST standardized **ML-DSA** (FIPS-204); Ethereum is specifying the
precompiles to verify it on-chain (**EIP-8051** ML-DSA, **EIP-7885** NTT). The window to migrate
opens now; this audit tells a protocol where it stands and what to change.

## Scope: what we score

For each value-authorizing surface (bridge attestation gate, multisig, token mint/admin, oracle,
governance), we score:

| # | Dimension | Vulnerable | Ready |
|---|-----------|-----------|-------|
| 1 | **Signature scheme** | ECDSA / BLS / bn254 pairing | ML-DSA (FIPS-204), SLH-DSA, or hash-based (Lamport/Merkle) |
| 2 | **Key custody** | bare EOA / single key; EIP-7702 delegated EOA | threshold / HSM with a PQ-capable signer |
| 3 | **Upgrade path** | immutable ECDSA verifier; no swap mechanism | pluggable verifier (e.g. `IAttestationVerifier`) that can be repointed to a PQ impl |
| 4 | **Hybrid posture** | ECDSA-only | hybrid ECDSA + ML-DSA during transition |
| 5 | **Proxy hygiene** | logic hidden behind a proxy, unscanned | implementation identified and scanned |
| 6 | **Migration target** | none | a concrete EIP-8051-backed verifier + cutover plan |

## Workflow

1. **Triage with the tool.** `evmsec pq-readiness <addr> --chain <c> --json` on every
   value-authorizing contract. A `quantumVulnerable: true` is a confirmed finding; `unknown`
   means "tool couldn't decide — go deeper", **never** "safe".
2. **Resolve proxies.** For any proxy (or `unknown` result), run `evmsec upgradeability <addr>`
   to get the implementation, then re-run `pq-readiness` on the implementation. Bytecode triage
   sees only the contract you point it at.
3. **Confirm from source.** The tool is a heuristic bytecode scanner (see *Limits*); confirm
   each finding against verified source — `ecrecover`, `EIP-712` permit, BLS/pairing libraries,
   or a PQ precompile call.
4. **Score & severity.** Map findings to the table above. Severity = (value at risk) ×
   (how directly a forged signature moves it). A bridge attestation gate or a token minter on
   ECDSA is **Critical**; a low-value, time-locked path is **Low**.
5. **Remediate.** Recommend a concrete migration: a pluggable PQ verifier delegating to the
   EIP-8051 precompile (reference: `MlDsaAttestationVerifier` and the draft ERC in
   [lock-mint-bridge-lab](https://github.com/0xSoftBoi/lock-mint-bridge-lab)), a hybrid
   ECDSA+ML-DSA window, and key-custody upgrades.

## Severity scale

| Severity | Meaning |
|----------|---------|
| Critical | A forged signature directly mints/moves significant value (bridge gate, token minter, treasury multisig). |
| High | Forgery compromises upgrades or governance with a delay/threshold that buys some time. |
| Medium | Vulnerable scheme on a non-custodial or low-value path. |
| Low / Info | Vulnerable but economically negligible, or already on a documented migration plan. |

## Limits (read before trusting a number)

`pq-readiness` is a **heuristic bytecode triage**, not a proof:
- It can **over-flag** (a constant near a `CALL`) and **under-flag** (a precompile call outside
  its detection window). It ships a `confidence` and lists indicators for exactly this reason.
- It deliberately **does not** assert "post-quantum / safe" from bytecode — those precompile
  addresses collide with common constants (e.g. `decimals = 18 = 0x12`), so a positive claim
  would be unreliable. Safety is confirmed from source, not the tool.
- It scans the contract you point it at — **resolve proxies first**.

A finding is only final after steps 2–3. See `examples/sample-pq-readiness-report.md`.
