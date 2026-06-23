# evmsec

[![ci](https://github.com/0xSoftBoi/evmsec/actions/workflows/ci.yml/badge.svg)](https://github.com/0xSoftBoi/evmsec/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small, focused **security CLI for EVM chains**. The flagship check answers the
one question behind every nine-figure bridge hack:

> Is this lock-and-mint bridge actually fully backed — or is it printing money?

Nomad ($190M), Wormhole, Ronin: in each case wrapped supply on the destination
chain stopped being backed by collateral locked on the source chain. `evmsec`
checks that invariant in one command, against any bridge, from the terminal.

```
balanceOf(token @ escrow)  ≥  totalSupply(wrappedToken)
   ^ source chain               ^ destination chain
```

A deficit is the money printer.

## Why this exists

`cast` already does balances/tx/gas. [revoke.finance](https://github.com/Jon-Becker/revoke-finance)
already does approvals. What nobody ships is a dead-simple, open-source,
CI-friendly **bridge solvency** check — so that's the flagship, with room for
more on-chain security checks under one tool.

## Install

```bash
npm install
cp .env.example .env   # optional: your own RPCs / bridge registry
```

## Usage

```bash
npm run evmsec -- <command> [args]
# or: npx tsx src/index.ts <command> [args]
```

### `solvency` — is the bridge backed?

```bash
# every route in the registry
npm run evmsec -- solvency --all

# one route by id
npm run evmsec -- solvency polygon-pos-usdc

# ad-hoc, no config needed
npm run evmsec -- solvency \
  --lock-chain ethereum --escrow 0xEscrow --token 0xUSDC \
  --mint-chain polygon  --minted 0xWrappedUSDC --json
```

Reports locked vs minted, the backing ratio, and a verdict. **Exit code is
non-zero when undercollateralized**, so it drops straight into CI or a cron:

```bash
*/5 * * * * evmsec solvency --all || alert "bridge backing breached"
```

Define your own verified routes in `bridges.json` (or point `EVMSEC_BRIDGES` at
your file). ⚠️ The bundled entries are *illustrative* — verify every address
against the bridge's own source before trusting a number. A security tool fed
the wrong escrow lies confidently.

#### `solvency --since` — *when* did backing break? (forensic)

After a hack, the question is "when did the bridge first go insolvent?"
`--since` binary-searches block history to pin the exact destination-chain block
where backing first dropped below the threshold — then lists the mint-token
transfers in that block as candidate causes.

```bash
npm run evmsec -- solvency my-route --since 2024-01-01
npm run evmsec -- solvency my-route --since 19000000   # or a block number
```

Because the invariant is cross-chain, the search axis is **time**: each
destination-chain block is mapped to the source chain by timestamp, so locked
and minted are compared at the same wall-clock moment. It checks the endpoints
first (must be healthy at `--since`, breached at head) and converges in ~25
probes over a 25M-block range.

> Needs an **archive RPC** (historical `balanceOf`/`totalSupply`). Set
> `ETHEREUM_RPC_URL` / `BASE_RPC_URL` / … to an archive endpoint; the public
> fallbacks only serve recent state.

### `upgradeability` — who can rug this?

```bash
npm run evmsec -- upgradeability 0xToken --chain base
```

Reads EIP-1967 slots: is it an upgradeable proxy, what's the implementation, and
is the upgrade admin a single EOA (one key from a rug) or a contract
(multisig/timelock)?

### `settlement` — did the cross-chain intent actually get filled?

For [ERC-7683](https://eips.ethereum.org/EIPS/eip-7683) intents: decode the
`Open` event on the source chain to learn what the filler *promised* to deliver
(`maxSpent`), then check the destination `fill` tx really delivered that token
and amount to the intended recipient, before the `fillDeadline`, and final.

```bash
npm run evmsec -- settlement \
  --source-chain ethereum --intent-tx 0xOpenTxHash \
  --fill-tx 0xFillTxHash [--dest-chain base] [--finality-depth 12] [--json]
```

Per output it reports `settled` / `unsettled` / `anomaly` and exits non-zero on
anything but a clean settlement — catching missing fills, wrong-recipient fills,
late fills, and underfills.

This is a **packaging** tool, honestly scoped — settlement logic lives inside
every solver, but not as a standalone auditor you can point at an arbitrary
intent. **v1 limits:** ERC-7683 only (Across/CoW/UniswapX have their own
formats); it verifies ERC-20 deliveries via Transfer logs (native-token outputs
are flagged, not proven); it does **not** cryptographically verify cross-chain
message proofs; and you supply the `--fill-tx` (auto-discovery needs an indexer
— roadmap). Treat it as a settlement *audit helper*, not an oracle of truth.

### `pq-readiness` — is this verifier quantum-safe, or printing forgeries later?

When a large quantum computer can run Shor's algorithm, every signature scheme
built on elliptic-curve discrete log — **ECDSA secp256k1, BLS, pairings** — is
forgeable. A bridge whose attestation gate, multisig, or token admin rests on
those carries **cryptographic migration debt**. Of the named institutional
digital-asset programs, ~0 have a disclosed post-quantum roadmap.

`pq-readiness` classifies the primitive a verifier reaches for, straight from its
deployed bytecode — which precompiles it calls (`ecrecover` 0x01, bn254 pairing
0x08, EIP-2537 BLS 0x0b–0x12, or a custom PQ precompile like an ML-DSA verifier),
and whether it's an EOA (incl. **EIP-7702** delegated accounts — still ECDSA-keyed).

```bash
npm run evmsec -- pq-readiness 0xVerifier --chain ethereum [--json]
```

Reports the scheme, a quantum-vulnerable verdict, the indicators it found, and a
confidence. **Exit code is non-zero when quantum-vulnerable**, so it drops into CI:

```bash
evmsec pq-readiness 0xBridgeVerifier || alert "bridge signatures are Shor-breakable"
```

Honestly scoped: this is a **heuristic bytecode scanner**, not a proof. It flags
**vulnerable** or returns **unknown** — it never asserts "post-quantum / safe" from
bytecode (those precompile addresses collide with common constants like `decimals = 18`).
Resolve proxies first (`upgradeability`) and confirm from source. The pure detection
logic (`pq-core.ts`) is unit-tested offline.

**Audit methodology.** The scoring rubric and workflow around this command —
triage → resolve proxies → confirm from source → score → remediate — are written up in
[`PQ_MIGRATION_AUDIT.md`](PQ_MIGRATION_AUDIT.md), with a worked
[sample report](examples/sample-pq-readiness-report.md) on mainnet contracts.

## Supported chains

`ethereum · base · arbitrum · optimism · polygon · sepolia · base-sepolia`
— override any RPC via env (`ETHEREUM_RPC_URL`, `BASE_RPC_URL`, …).

## Layout

```
src/
  config.ts                chains, RPCs
  lib.ts                   provider cache, ABIs (ERC-20 / ERC-7683), proxy slots, math, bisection
  lib.test.ts              unit tests for the pure logic (no network)
  settlement-core.ts       pure ERC-7683 delivery-matching + verdict logic
  pq-core.ts               pure post-quantum scheme classification (bytecode → verdict)
  pq-core.test.ts          unit tests for the PQ classifier (no network)
  settlement-core.test.ts  unit tests for settlement logic (no network)
  bridges.ts               route registry loader
  commands/
    solvency.ts            flagship: lock-vs-mint backing check
    upgradeability.ts      EIP-1967 / legacy proxy admin risk
    settlement.ts          ERC-7683 cross-chain intent fill verification
    pq-readiness.ts        post-quantum readiness of a verifier (Shor-breakable?)
  index.ts                 CLI dispatcher
bridges.json               route registry (verify before trusting)
```

## Development

```bash
npm install
npm run typecheck     # strict tsc
npm test              # node:test via tsx — pure logic, no network
```

The backing math, the forensic bisection, and the proxy-slot parsing are
unit-tested and run offline; CI (`.github/workflows/ci.yml`) runs typecheck +
tests on Node 20 and 22 for every push and PR.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full, scoped plan (each item is grounded
in prior art with an approach + acceptance criteria, and has a tracking issue):

- `mint-authority <token>` — who can mint; is ownership renounced?
- `solvency --watch` — alert the moment backing breaks
- multi-asset bridges (sum escrows across many tokens)
- a CI-validated, community-verified `bridges.json` registry
- `settlement`: more intent formats (Across, CoW, UniswapX), fill-tx
  auto-discovery, cross-chain message-proof verification, `settlement diagnose`

## Contributing

Verified bridge routes and new checks welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
Every registry address must cite a primary source (the bridge's own deployment
docs / verified contract); routes that can't be traced won't be merged.

## License

MIT
