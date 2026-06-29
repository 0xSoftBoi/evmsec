# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`oracle-hygiene <feed>` command**: is a Chainlink-style price feed fresh and
  safe to read _right now_? Pulls `latestRoundData()` and flags the failure modes
  a consumer can't see when it blindly trusts the price — a **stale** answer
  (older than `--heartbeat`, default 3600s → critical), a **zero/negative**
  answer (critical), an **incomplete** round (`updatedAt == 0`), and a
  **carried-over** round (`answeredInRound < roundId` → elevated). On L2s,
  `--sequencer <uptime-feed>` adds the Chainlink sequencer-uptime check: a
  sequencer reported **down** is critical (a fresh price is meaningless if the
  chain was offline), and one that only just restarted (within `--grace`, default
  1h) is elevated. Staleness is measured against the chain's own latest-block
  timestamp. Exits non-zero when the feed is unusable. Pure logic in
  `oracle-core.ts` is unit-tested; validated live against mainnet ETH/USD and the
  Arbitrum sequencer feed.
- **`admin-power <address>` command**: answers not just _who_ controls a contract
  (as `upgradeability` does) but _what kind_ of authority it is — the question
  that decides the blast radius. Resolves the controlling authority (EIP-1967 /
  legacy proxy admin slot, else `owner()`) and classifies it: a single **EOA**
  (critical, fails CI), a **Gnosis Safe** (reads `getThreshold()`/`getOwners()` —
  a 1-of-N Safe is treated as a single key and fails CI; m-of-n reads info with
  the threshold shown), a **timelock** (reads OZ `getMinDelay()` or Compound-style
  `delay()` — a delay of 0 or below the `--min-delay` floor, default 24h, is
  elevated), an unrecognized **contract** (elevated — inspect; may be a ProxyAdmin
  or custom controller), or **renounced** (zero address). Exits non-zero when a
  single key controls the contract. Pure classification logic
  (`authority-core.ts`) is unit-tested offline.
- **`message-proof` command**: verifies that a cross-chain message was _validly
  attested_ (not just that tokens arrived) by checking the attestation on the
  destination via a single `eth_call` — Wormhole `Core.parseAndVerifyVM(vaa)`
  (guardian signatures) and Hyperlane `Mailbox.delivered(messageId)` (ISM-verified
  and executed). Exits non-zero unless verified. Core/Mailbox addresses are
  bundled for ethereum/base/arbitrum/optimism/polygon (each verified live before
  bundling), overridable with `--contract`. LayerZero is intentionally deferred
  (its per-message DVN check needs full Origin/nonce context, not a view call).
  Validated end-to-end on mainnet: a real VAA verifies, a tampered one is
  rejected, an unknown Hyperlane id reads unverified. The pure VAA parser and
  verdict classifiers (`message-proof-core.ts`) are unit-tested.
- **`mint-authority <token>` command**: answers "can the wrapped supply be
  inflated, and by whom?" — the rug vector `solvency` doesn't cover. Follows the
  proxy to its implementation, scans bytecode for mint/burn/pause entrypoints, a
  supply **cap**, and the auth model (Ownable vs AccessControl). For Ownable
  tokens it reads `owner()`; for AccessControl tokens it **enumerates the actual
  `MINTER_ROLE` holders** (AccessControlEnumerable, or `RoleGranted` history as
  a fallback) and classifies each EOA vs contract, reads the **cap value**, and
  exits non-zero when an inflatable supply sits under a single EOA. Pure logic in
  `mint-authority-core.ts` is unit-tested offline.
- **`pause-guardian <token>` command**: can transfers be frozen, are they frozen
  right now, and who holds the pause key? Follows the proxy, detects the Pausable
  surface + auth model, reads `paused()`, and resolves the guardian (Ownable
  `owner()` or enumerated `PAUSER_ROLE` holders). Exits non-zero when a single
  EOA can freeze transfers. Pure logic in `pause-guardian-core.ts` is
  unit-tested.
- **`solvency --watch`**: poll routes on an interval and alert once per breach
  transition (`--interval`, optional `--webhook` JSON POST); steady state is
  silent, clean shutdown on SIGINT/SIGTERM. Transition logic in
  `solvency-core.ts` is unit-tested.
- **Multi-asset / multi-escrow routes**: a route's `lock` may now be an array of
  legs `{chain, escrow, token}`, summed (normalized to 18 dp) against the minted
  supply. Backward-compatible with single-leg routes.
- **Settlement protocol abstraction**: settlement now decodes intents through a
  pluggable `Protocol` interface (`parseIntent`/`parseFill`) under
  `src/protocols/`, selected with `--protocol` (default `erc7683`). Today's
  ERC-7683 logic moved behind it unchanged; the shared delivery-matching core is
  reused. Settlement reads now also use the RPC retry layer; JSON output gains a
  `protocol` field.
- **Across and CoW settlement decoders**: `--protocol across` decodes the
  SpokePool deposit event (both the modern `FundsDeposited` bytes32 shape and the
  legacy `V3FundsDeposited`); `--protocol cow` decodes GPv2Settlement `Trade`
  events (same-chain — pass the settlement tx as both intent and fill). ABIs are
  from the official contracts; decoders are pure and round-trip-tested.
  **UniswapX is intentionally not added** — its `Fill` event carries no output
  amounts, so the promise can't be read from logs alone.
- **Settlement fill-tx auto-discovery**: omit `--fill-tx` and the tool scans the
  last `--scan-blocks` (default 50k) of the destination for the matching ERC-20
  delivery (chunked to survive `getLogs` range caps) and picks the earliest tx
  that satisfies the output, falling back to a clear message otherwise. The
  selection + chunking logic (`discovery-core.ts`) is pure and unit-tested.
- **`settlement diagnose`**: the forensic counterpart — for an intent that should
  have settled but didn't, scans the destination for deliveries to the recipient
  and classifies the failure mode (`never-filled` / `underfilled` / `filled-late`
  / `settled`) with on-chain evidence, exiting non-zero on anything but settled.
  The classifier (`diagnose-core.ts`) is pure and unit-tested.
- **Registry validation**: `npm run validate:registry` checks `bridges.json` for
  shape, unique kebab-case ids, known chains, EIP-55 **checksummed** addresses,
  and a cited source URL for any route not marked `"verified": false`. Wired into
  CI so a malformed or uncited registry PR fails. Pure logic in `registry-core.ts`
  is unit-tested. Adds an optional `verified` field to a route.
- **`upgradeability --json`**: the command now has machine-readable output, so
  it drops into CI like the others.
- **RPC resilience**: every on-chain read goes through a request timeout
  (`EVMSEC_RPC_TIMEOUT_MS`) and bounded exponential-backoff retry on transient
  errors only (`EVMSEC_RPC_RETRIES`); real errors still surface immediately.
- **Tooling**: ESLint (flat config, type-aware) and Prettier, wired into a
  single `npm run check` gate (format → lint → typecheck → test).
- **Build/packaging**: a real compiled build (`tsc` → `dist/`); the published
  `bin` now runs on plain Node without `tsx`. `prepublishOnly` rebuilds before
  publish.
- **CI**: least-privilege `permissions`, run-cancelling `concurrency`, and a
  dedicated quality job (lint, format, typecheck, build) alongside the Node
  20/22 test matrix.
- **Project governance**: `SECURITY.md`, `CODE_OF_CONDUCT.md`, this changelog,
  `.editorconfig`, Dependabot config, and GitHub issue/PR templates (including a
  structured bridge-route submission form).

### Changed

- **`mint-authority` resolves a FiatToken `masterMinter`**: when a token exposes
  `masterMinter()` (USDC-class), the tool reads and classifies it (the
  masterMinter, not `owner()`, gates minting) and the verdict reflects it — an
  EOA masterMinter is critical. Adds a `hasMasterMinter` surface flag and a
  `masterMinter` field to the output.
- **`solvency --watch --delta <pp>`**: also alert on a sudden backing drop of at
  least that many points between observations, even while a route is still above
  the breach threshold. Degrade detection (`computeDegrades`) is unit-tested.
- **`solvency --all` runs routes with bounded concurrency** (`EVMSEC_CONCURRENCY`,
  default 5) instead of strictly sequentially, and isolates per-route failures:
  an unreadable route is reported as `ERROR` and fails the exit code without
  aborting the scan or masking the other routes.
- `tsx` moved from runtime `dependencies` to `devDependencies` — it is only
  needed for development now that the package ships compiled JavaScript.

### Fixed

- **Test discovery on Node 20**: the previous `tsx --test src/**/*.test.ts`
  relied on glob expansion that neither POSIX `sh` nor the Node 20 test runner
  performs, so the Node 20 CI leg discovered no test files. Discovery is now
  done explicitly in `scripts/run-tests.mjs` and behaves identically across
  shells and Node 20/22.

## [0.1.0]

Initial release.

### Added

- `solvency` — lock-and-mint bridge backing check (`balanceOf(escrow) ≥
totalSupply(wrapped)`), with `--all`, ad-hoc routes, `--json`, and a
  non-zero exit on undercollateralization.
- `solvency --since` — forensic binary search for the block where backing first
  broke, aligning the source chain to each destination block by timestamp.
- `upgradeability` — EIP-1967 / legacy zeppelinos proxy and upgrade-admin risk
  check.
- `settlement` — ERC-7683 cross-chain intent fill verification.
- `pq-readiness` — post-quantum readiness classification of a verifier from its
  deployed bytecode.
- Unit-tested pure logic (backing math, forensic bisection, proxy-slot parsing,
  PQ classification, settlement matching) running with no network.

[unreleased]: https://github.com/0xSoftBoi/evmsec/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0xSoftBoi/evmsec/releases/tag/v0.1.0
