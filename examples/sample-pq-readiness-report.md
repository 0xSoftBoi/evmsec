# Sample PQ-readiness report — Ethereum mainnet (illustrative)

A worked example of the [methodology](../PQ_MIGRATION_AUDIT.md) on well-known mainnet contracts.
Generated with `evmsec pq-readiness` (Opus-assisted analysis). Addresses are public; this is a
teaching sample, not a commissioned audit.

## Triage results

| Target | Address | `pq-readiness` | Finding |
|--------|---------|----------------|---------|
| Gnosis Safe 1.3.0 singleton | `0xd9Db…9552` | `ecdsa` / **vulnerable** | Owner approvals are ECDSA `ecrecover` — Shor-breakable. |
| DAI stablecoin | `0x6B17…1d0F` | `ecdsa` / **vulnerable** | EIP-2612 `permit` authorizes transfers via `ecrecover`. |
| Vitalik's account | `0xd8dA…6045` | `eoa` / **vulnerable** | EIP-7702 delegated EOA — still an ECDSA secp256k1 key. |
| USDC (FiatTokenProxy) | `0xA0b8…eB48` | `unknown` | A proxy — bytecode triage sees the proxy, not the logic. **Resolve before concluding.** |

```console
$ evmsec pq-readiness 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552 --chain ethereum
  scheme          ECDSA (ecrecover)
  verdict         ⚠ QUANTUM-VULNERABLE — Shor-breakable signatures
  confidence      medium
  indicators
    • calls ecrecover precompile (0x01) → ECDSA secp256k1 (Shor-breakable)
```

## Resolving the proxy (methodology step 2)

`unknown` is not "safe". Resolve the implementation, then re-scan it:

```console
$ evmsec upgradeability 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 --chain ethereum
  pattern         legacy zeppelinos proxy (pre-EIP-1967)
  implementation  0x43506849D7C04F9138D1A2050bbF3A0c054402dd   # FiatTokenV2_2
$ evmsec pq-readiness 0x43506849D7C04F9138D1A2050bbF3A0c054402dd --chain ethereum
  # USDC's permit (EIP-2612 / EIP-3009) authorizes via ecrecover → ECDSA, vulnerable.
```

The proxy hid an ECDSA `permit`/`transferWithAuthorization` surface. This is why the methodology
mandates proxy resolution: triaging the proxy alone would have left a Critical surface as `unknown`.

## Scoring

| Target | Dimension hit | Severity | Rationale |
|--------|---------------|----------|-----------|
| Safe multisig | scheme (ECDSA), custody | **Critical** | A forged owner signature moves whatever the Safe holds. |
| DAI / USDC permit | scheme (ECDSA) | **Critical** | A forged `permit` authorizes token transfers at scale. |
| 7702 EOA | scheme + custody (single key) | **High** | Direct account takeover; scope = that account's balance. |

## Remediation (what we'd recommend)

1. **Pluggable verifier.** Put signature checks behind a swappable interface (e.g.
   `IAttestationVerifier`) so the scheme can change without touching app logic.
2. **PQ target.** Add an ML-DSA verifier delegating to the **EIP-8051** precompile — reference
   implementation + draft ERC in
   [lock-mint-bridge-lab](https://github.com/0xSoftBoi/lock-mint-bridge-lab).
3. **Hybrid window.** Accept ECDSA **and** ML-DSA during the transition; flip the order of trust
   as the precompile ships and keys rotate.
4. **Custody.** Move single-key/EOA authorizers to threshold or HSM signers with a PQ-capable path.

## Caveat

Confidence is `medium` on the bytecode triage and `unknown` results require the proxy/source
steps above. Numbers here are a teaching illustration — a commissioned engagement confirms every
finding against verified source. See [methodology](../PQ_MIGRATION_AUDIT.md).
