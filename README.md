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
your file). ⚠️ The bundled entries are _illustrative_ — verify every address
against the bridge's own source before trusting a number. A security tool fed
the wrong escrow lies confidently.

**Multi-asset / multi-escrow routes.** A route's `lock` may be an **array of
legs** (each `{ chain, escrow, token }`). The legs are summed — normalized to 18
decimals — against the minted supply, so a bridge that spreads collateral across
several escrows or chains is checked as one invariant. The legs must denominate
the same unit as the minted token; summing differently-priced assets needs a
price oracle and is deliberately out of scope.

```jsonc
"lock": [
  { "chain": "ethereum", "escrow": "0xEsc1", "token": "0xUSDC" },
  { "chain": "ethereum", "escrow": "0xEsc2", "token": "0xUSDC" }
]
```

#### `solvency --watch` — alert the moment backing breaks

Poll the routes on an interval and alert **once per breach transition** (a route
going under, or recovering) — steady state is silent, so it won't spam. Optional
`--webhook` POSTs a JSON alert; clean shutdown on Ctrl-C.

```bash
npm run evmsec -- solvency --all --watch --interval 60 --webhook https://hooks.example/bridge
```

A self-hosted alternative to managed monitoring: no infra, just a process (or a
container) watching the invariant and paging you on the transition.

#### `solvency --since` — _when_ did backing break? (forensic)

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
(multisig/timelock)? Add `--json` to drop it into CI.

### `mint-authority` — can the wrapped supply be inflated, and by whom?

`solvency` says a bridge is backed _now_. But a token can read 100% backed today
and still carry an open mint function — a future money printer one key away from
use. This asks the next question every auditor asks: **who, if anyone, can
inflate the supply?**

```bash
npm run evmsec -- mint-authority 0xWrappedToken --chain polygon [--json]
```

It follows the proxy to its implementation (most bridge tokens are proxies),
scans the bytecode for mint/burn/pause entrypoints, a supply **cap**, and the
auth model (Ownable vs OpenZeppelin AccessControl). For Ownable tokens it reads
`owner()`; for AccessControl tokens it **enumerates the actual `MINTER_ROLE`
holders** (via AccessControlEnumerable, or `RoleGranted` history as a fallback)
and classifies each as a single **EOA** (one-key inflation risk) or a
**contract** (multisig/timelock — inspect it). It also reads the **cap value**
when present, so bounded inflation reads differently from uncapped. **Exit code
is non-zero when an inflatable supply sits under a single EOA**, so it drops into
CI alongside `solvency`:

```bash
evmsec mint-authority 0xWrappedToken || alert "wrapped token mint is single-key controlled"
```

Honestly scoped like the others: a bytecode + on-chain-read heuristic, not a
proof. Role enumeration is best-effort (a public RPC that caps `getLogs` ranges
may return an incomplete set — the tool says so), and some tokens route minting
through a separate `masterMinter` rather than `owner()` — so it flags, explains,
and tells you to confirm the gating against source. The detection logic
(`mint-authority-core.ts`) is unit-tested offline.

### `pause-guardian` — can transfers be frozen, and who holds the key?

Many bridge tokens are Pausable. A single key that can pause a wrapped asset can
halt every holder at once — a liveness / censorship vector. This asks: **is the
token pausable, is it paused right now, and who holds the pause authority?**

```bash
npm run evmsec -- pause-guardian 0xWrappedToken --chain polygon [--json]
```

Same shape as `mint-authority`: follows the proxy, detects the Pausable surface
and auth model, reads `paused()` to report the **current** state, and resolves
the guardian — Ownable `owner()` or the enumerated `PAUSER_ROLE` holders,
classified EOA vs contract. **Exit code is non-zero when a single EOA can freeze
transfers.** A currently-paused token is flagged prominently regardless of who
holds the key. Heuristic, honestly scoped; logic in `pause-guardian-core.ts` is
unit-tested.

### `settlement` — did the cross-chain intent actually get filled?

For [ERC-7683](https://eips.ethereum.org/EIPS/eip-7683) intents: decode the
`Open` event on the source chain to learn what the filler _promised_ to deliver
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
— roadmap). Treat it as a settlement _audit helper_, not an oracle of truth.

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

## Reliability

Public RPCs are flaky, and a security check that aborts on a transient blip is
worse than useless in a cron. Every on-chain read goes through a per-request
timeout (`EVMSEC_RPC_TIMEOUT_MS`, default 20s) and bounded exponential-backoff
retry on transient errors only — timeouts, 429s, 5xx, resets — while real errors
(reverts, bad input) surface immediately (`EVMSEC_RPC_RETRIES`, default 3).
`solvency --all` checks routes with bounded concurrency (`EVMSEC_CONCURRENCY`,
default 5) and isolates per-route failures: one unreadable route is reported as
`ERROR` and fails the exit code, without masking the others.

## Layout

```
src/
  config.ts                  chains, RPCs
  lib.ts                     provider cache + RPC retry/concurrency, ABIs, proxy slots, math, bisection
  lib.test.ts                unit tests for the pure logic (no network)
  solvency-core.ts           pure backing summation, breach predicate, watch transitions
  registry-core.ts           pure bridges.json validator (shape, chains, checksums, sources)
  settlement-core.ts         pure delivery-matching + verdict logic (protocol-agnostic)
  protocols/                 pluggable settlement decoders (Protocol interface; erc7683)
  pq-core.ts                 pure post-quantum scheme classification (bytecode → verdict)
  mint-authority-core.ts     pure mint/auth capability classification (bytecode → verdict)
  pause-guardian-core.ts     pure pause capability + guardian classification
  *-core.test.ts             unit tests for the pure cores (no network)
  bridges.ts                 route registry loader
  commands/
    solvency.ts              flagship: lock-vs-mint backing check
    upgradeability.ts        EIP-1967 / legacy proxy admin risk
    mint-authority.ts        who can inflate the wrapped supply?
    pause-guardian.ts        who can freeze transfers?
    settlement.ts            ERC-7683 cross-chain intent fill verification
    pq-readiness.ts          post-quantum readiness of a verifier (Shor-breakable?)
  index.ts                   CLI dispatcher
bridges.json                 route registry (verify before trusting)
```

## Development

```bash
npm install
npm run check         # format + lint + typecheck + tests, in one gate
```

Individual steps:

```bash
npm run format        # Prettier (write)   ·  npm run format:check in CI
npm run lint          # ESLint              ·  npm run lint:fix to autofix
npm run typecheck     # strict tsc, no emit
npm test              # node:test via tsx — pure logic, no network
npm run test:coverage # the same, with V8 coverage
npm run validate:registry  # check bridges.json (shape, chains, checksums, sources)
npm run build         # compile to dist/ (what `prepublishOnly` ships)
```

The backing math, the multi-asset summation, the forensic bisection, the
`--watch` transition logic, the proxy-slot parsing, the PQ / mint-authority /
pause-guardian classifiers, the RPC retry/concurrency helpers, and the
settlement matcher are unit-tested and run offline. Test
discovery is explicit (`scripts/run-tests.mjs`) so it behaves identically across
shells and Node versions. CI (`.github/workflows/ci.yml`) runs lint, format,
typecheck, and build once, plus the test suite on Node 20 and 22, for every push
and PR.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full, scoped plan (each item is grounded
in prior art with an approach + acceptance criteria, and has a tracking issue):

- a CI-validated, community-verified `bridges.json` registry
- `settlement`: more intent formats (Across, CoW, UniswapX), fill-tx
  auto-discovery, cross-chain message-proof verification, `settlement diagnose`

## Contributing

Verified bridge routes and new checks welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).
Every registry address must cite a primary source (the bridge's own deployment
docs / verified contract); routes that can't be traced won't be merged.

## License

MIT
