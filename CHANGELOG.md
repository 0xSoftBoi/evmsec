# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Broader route & chain coverage.** Added **Linea** and **Scroll** to the chain
  config (so `audit` and ad-hoc `solvency` reach them) and two new live-verified routes
  to the registry: **base-usdbc** (USDC→Base USDbC via the L1StandardBridge, ~103%) and
  **scroll-usdc** (USDC→Scroll via Scroll's dedicated L1 USDC Gateway, ~109% — a
  single-asset gateway, so the surplus is real backing). Registry is now **11 routes
  across 5 chains**. Verify-first held the line: Arbitrum USDC.e (reads 0% against the
  standard gateway — it uses a custom one), Optimism USDC/USDT (unexplained 13–18%
  excess), and Linea USDC (canonical bridge deprecated for native USDC) were all tested
  and left out. `normalizeAsset` gained an alias fold so bridged labels like `USDbC`
  price off the canonical USDC feed.

- **Unattended breach alerting + trend history.** The scheduled
  [`bridge-status` workflow](.github/workflows/bridge-status.yml) now **opens a GitHub
  issue** the moment a route goes undercollateralized (labelled `bridge-breach`, de-duped
  to one open issue) and **closes it on recovery** — a bridge-watch that pages you, with
  no external monitoring service. Only a genuine breach opens an issue; an unreadable RPC
  (`degraded`) never does, so a flaky endpoint can't cry wolf. `gen:status` also appends a
  compact rollup to `STATUS.history.jsonl` each run (capped to the last 720 entries), so
  the feed carries a trend, not just a snapshot.

- **USD valuation of bridge backing (on-chain Chainlink).** `solvency` now prices
  each route's locked/minted collateral in dollars — `$1.18B locked · $1.17B minted`,
  and the **deficit in USD** on a breach — by reading canonical Chainlink aggregators
  on Ethereum mainnet at check time (no external API, no key). Stablecoins are priced
  off their real `USDC/USD` / `DAI/USD` feeds (a depeg shows up instead of hiding
  behind an assumed `$1`); WBTC values via `BTC/USD` and cbETH composes
  `cbETH/ETH × ETH/USD`. All feed addresses were verified live before pinning. USD is
  best-effort — a price hiccup never masks the backing verdict. New `priceUsd` /
  `lockedUsd` / `mintedUsd` / `deltaUsd` / `pricedVia` fields in `--json`; the pure
  math (`usd-core.ts`) is unit-tested. `STATUS.md` gains a **Value** column and a
  total-collateral headline, `STATUS.json` carries per-route `lockedUsd` +
  `totalLockedUsd`, and the badge shows tracked TVL (e.g. **bridges: 9/9 backed · $2.50B**).

- **Machine-readable status feed + live badge.** `npm run gen:status` now emits,
  alongside `STATUS.md`, a `STATUS.json` feed (`{ generatedAt, overall, backed,
breached, errored, total, routes[] }`) that any monitor or dashboard can consume,
  and a [shields.io](https://shields.io) endpoint `badge.json` that renders the live
  **bridges: N/N backed** badge now shown in the README. The scheduled
  [`bridge-status` workflow](.github/workflows/bridge-status.yml) commits all three
  artifacts back only when the numbers change.

- **Live bridge-status page + more verified routes.** `STATUS.md` is an
  auto-generated "is every bridge in the registry backed right now?" page —
  `npm run gen:status` (`scripts/gen-status.mjs`) runs `solvency --all` and
  formats it as a Markdown table (locked / minted / backing per route), and the
  scheduled [`bridge-status` workflow](.github/workflows/bridge-status.yml)
  refreshes it every 6 hours, committing back only when the numbers change. It's
  the open-source bridge-watch the ecosystem lacks, in ~40 lines. The registry
  grew to **9 live-verified routes** across Polygon PoS, Arbitrum, OP Mainnet, and
  Base (added OP-WBTC, Base-DAI, Base-cbETH — each verified `BACKED` first;
  OP-USDT's unexplained 13% excess was left out). Also: an empty `<CHAIN>_RPC_URL`
  (an unset CI secret expands to `""`) now falls back to the public endpoint
  instead of becoming a broken empty URL.

- **`bridges.json` seeded with real, live-verified routes** — so the flagship
  `solvency --all` actually does its headline job out of the box instead of
  shipping illustrative placeholders. Six routes across two bridges and two
  destination chains: USDC / DAI / WBTC on **Polygon PoS** (the ERC20 predicate
  escrow) and DAI (MakerDAO escrow) / WBTC / LINK on **Arbitrum** (the canonical
  L1 gateway). Every route was checked live to be `BACKED` (locked ≥ minted,
  ~100%) before inclusion, each with its escrow linked in `notes`; the registry
  validator enforces checksummed addresses + a cited source. Routes that _didn't_
  verify were deliberately left out rather than shipped as false alarms — e.g.
  USDT-on-Polygon reads 0.9% against the standard predicate (it isn't the real
  escrow), and single-escrow WETH routes are multi-path. Re-verify before relying
  on any number: escrows change.

- **Distribution — Docker image + npm release automation.** A multi-stage
  `Dockerfile` (build → slim `node:22-alpine` runtime, non-root, ~300 MB) ships
  both bins; `docker run … ghcr.io/0xsoftboi/evmsec audit 0x…` needs no Node.
  Verified building and running end-to-end (a live `admin-power` check from inside
  the container). A `release` workflow publishes to npm **with provenance** and
  pushes the image to GHCR on a `v*` tag (`npm version patch && git push
--follow-tags`), gated on the full `npm run check`. `publishConfig.access` set
  for a clean `npm publish`; the published build drops source/declaration maps
  (225 → 115 files, ~106 kB packed). README documents `npx evmsec` / Docker /
  from-source install.

- **`deps` command — audit your on-chain dependencies.** Reframes the audit from
  "a contract" to "every external contract your protocol trusts" (the USDC you
  hold, the Chainlink feed you price off, the bridge you route through — your
  on-chain supply chain). Reads a `deps.json` manifest (`--file` / `EVMSEC_DEPS` /
  positional; see `deps.example.json`), runs the full audit family against each
  entry, and rolls the results into one verdict with a per-dependency report card.
  Exits non-zero when any dependency has a blocking finding (`--fail-on` sets the
  bar), so a dependency quietly becoming single-key-controlled fails your CI.
  `--json` / `--sarif` emit the aggregate (SARIF now spans multiple targets).
  Manifest validation (`deps-core.ts`) is pure and unit-tested. A new
  `assessTarget()` in `checks/run.ts` is the shared "fetch bytecode once → run
  checks" core behind `audit`, `deps`, and the MCP server.
- **MCP server (`evmsec-mcp`)** — exposes the checks as [Model Context
  Protocol](https://modelcontextprotocol.io) tools over stdio, so an AI agent can
  ask "is this contract safe to interact with?" before signing, or fold an
  on-chain-state audit into a workflow. Tools: `audit_contract { address, chain? }`
  (structured verdict + per-check findings + evidence, with an explicit heuristic
  disclaimer) and `list_supported_chains`. `stdout` is the protocol channel;
  logging goes to `stderr`. Ships as a second `bin`; wire it in with
  `npx -y evmsec-mcp`.

- **`freeze-authority <token>` command + check**: the targeted-censorship sibling
  of `pause-guardian` — can an _individual_ holder be frozen (or their balance
  seized), and who holds that power? Detects the two dominant on-chain patterns:
  **FiatToken** (USDC-class) `blacklist(addr)` gated by a `blacklister()` role, and
  **Tether** (USDT) owner-gated `addBlackList(addr)` plus `destroyBlackFunds(addr)`
  (which _burns_ a frozen balance — a seize, flagged distinctly). Resolves the
  actual authority (`blacklister()` or `owner()`), classifies it, and exits
  non-zero when a single EOA can freeze/seize any holder. Part of `audit`. Pure
  logic (`freeze-core.ts`) unit-tested; validated live — USDC's blacklister is a
  single EOA (`freeze-authority: critical`), USDT's owner can freeze+seize
  (`warning`). Both pinned by the incident fixtures.
- **Incident fixtures — verdicts regression-tested against real mainnet contracts,
  offline** (`src/incident-fixtures.test.ts`, `src/testing/replay-provider.ts`,
  `src/fixtures/incidents/`, `scripts/capture-fixtures.ts`): a record/replay
  harness captures the exact on-chain reads a check makes (at the ethers
  `_perform` choke point) against a named contract, commits them, and replays them
  through the **real** assessors with no network. Pinned so far: USDC (proxy admin
  is a bare EOA on-chain → `admin-power` critical), USDT / WBTC (owner is an
  unrecognized controller → warning, not a rubber-stamp), Ethena USDe (a real
  5-of-10 Gnosis Safe → `ok`; exercises the live `getThreshold`/`getOwners` path
  and guards against over-flagging reasonable multisigs), Compound cUSDC (admin
  via a non-standard getter → reported unresolved, a documented blind spot), and
  DAI (not a proxy → no false upgradeability alarm). A drifting heuristic now
  fails CI. Regenerate with `npm run capture:fixtures`. Replay fidelity was
  checked directly (every replayed read hits a recording — zero cache misses — so
  the tests aren't vacuously green).
- **Check framework + SARIF/JSON for every contract check** (`src/check.ts`,
  `src/checks/`): the six contract-audit checks are now each a `Check` over a
  shared `CheckContext` (bytecode fetched **once** and reused across checks),
  returning a structured `CheckReport`. A single runner parses args, runs one
  check or the whole family, and renders **human / `--json` / `--sarif`** output —
  so every check (not just `audit`) gains a machine-readable aggregate and
  GitHub code-scanning (SARIF 2.1.0) support, and `--fail-on <severity>` controls
  the exit threshold (`critical` default, or `warning`). The standalone commands
  are now thin wrappers over the same engine; ~600 lines of per-command argument
  parsing, `getCode`, proxy-resolution, and printing duplication were removed, and
  `audit` no longer fakes aggregation by snooping `process.exitCode`.
- **GitHub Action** (`action.yml`): a composite action that runs any evmsec
  command in CI via an `args` input (e.g. `audit 0xContract --chain ethereum`).
  It builds evmsec from its own checkout, so it works today without an npm
  release; `uses: 0xSoftBoi/evmsec@main`. A failing check fails the job. README
  documents a ready-to-paste `security.yml` workflow.
- **`audit <address>` meta-command**: runs every check that applies to a generic
  contract — `verification-status`, `compiler-bugs`, `upgradeability`,
  `admin-power`, `mint-authority`, `pause-guardian` — and prints one consolidated
  report card with a pass/fail per check and an overall verdict. Exits non-zero if
  any check fails, so `evmsec audit 0x… || alert` covers the lot in one CI line.
  `oracle-hygiene` is intentionally excluded (it only applies to price feeds and
  would revert on a generic contract).
- **`verification-status <address>` command**: is the contract's source verified?
  Queries Sourcify v2 (`GET /v2/contract/{chainId}/{address}`) and classifies the
  result as a full **exact match**, a **partial match** (bytecode matches but the
  metadata hash differs — functionally verified), or **unverified**. Exits
  non-zero when no verified source is found; a provider that's unreachable reads
  `unknown` (a network condition, not a verdict) and does not fail CI. Server
  overridable with `--sourcify`, HTTP timeout via `EVMSEC_HTTP_TIMEOUT_MS`. Pure
  classification (`verification-core.ts`) is unit-tested; validated live against
  Sourcify.
- **`compiler-bugs <address>` command**: was this contract compiled with a solc
  version subject to a known compiler bug? Reads the exact solc version from the
  bytecode's CBOR metadata trailer (following the proxy to its implementation)
  and matches it against the Solidity team's own published `bugs.json` /
  `bugs_by_version.json` (bundled in `src/data/solc-bugs.ts`, regenerated with
  `npm run gen:solc-bugs`). Each finding links to the official writeup.
  Condition-gated bugs (viaIR/optimizer/evmVersion) read `warning` with their
  conditions surfaced, since applicability can't be read from bytecode. In
  practice this is a **warning-level check**: every high-severity solc bug in the
  CBOR-metadata era (≥0.4.22) is condition-gated, so the `critical`
  (unconditional-high) path — while implemented and unit-tested — effectively
  never fires for a real modern contract. A contract that strips metadata or
  predates CBOR tags reports "version not found" rather than guessing. Pure logic
  (`compiler-core.ts`) is unit-tested; validated live (USDC's 0.6.12
  implementation, pre-CBOR WETH).
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

- **`admin-power` no longer passes an unresolved controller**: when no EIP-1967
  admin and no `owner()` can be resolved, the verdict now reads `⚠ WARNING`
  ("control may live in a custom scheme; inspect") instead of a clean `ok` — a
  security tool saying "I couldn't tell who controls this" shouldn't look like a
  pass. Renounced (zero address) still reads `ok`. Pinned by the DAI / cUSDC
  incident fixtures.
- **Safe-threshold heuristic — now conservative, and honestly framed**: an
  earlier iteration of this changelog claimed the check flags a 2-of-5 Safe "the
  exact shape of the Harmony Horizon bridge." That was doubly wrong: Harmony's
  bridge was a **custom** 2-of-5, not a Gnosis Safe (this path never classifies
  it), and the rule as written also flagged ordinary configs like a 5-of-10 Safe
  (real example: Ethena USDe) as a warning. Corrected: `admin-power` flags a
  Gnosis Safe only when the threshold is a **strict minority** of signers
  (`2·threshold < owners`, e.g. 2-of-5, 4-of-10); a threshold at least half
  (2-of-3, 3-of-5, 5-of-10) is `info`. 1-of-N is still `critical`. The summary now
  states plainly that threshold is a _weak_ signal — Ronin was 5-of-9 (a majority)
  and still lost $625M. Pinned by the Ethena USDe fixture (a real 5-of-10 Safe →
  `ok`). Pure logic in `authority-core.ts`, unit-tested.
- **Unified, sharper check output**: every contract-audit command now renders
  through the shared framework — a consistent severity-marked report with
  structured evidence (addresses get explorer links) and a report card for
  `audit`. `compiler-bugs` now surfaces only the bugs that drive the verdict
  (medium and above) and collapses the long tail of low/very-low bugs into a
  count, instead of dumping the whole list. JSON output changed shape to the
  unified `{ overall, counts, reports[] }` aggregate (pre-1.0, unreleased).
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

- **`pause-guardian` misattributed the pause key on FiatToken tokens**: USDC-class
  tokens gate pausing through a separate `pauser()` role, but the check assumed
  `owner()` and pointed at the wrong address (hedged with "if it gates pausing").
  It now detects the `pauser()` getter and resolves/classifies that address
  directly — for USDC it correctly reports the pause authority as a single EOA via
  `pauser()` (0x4914…8566), not the owner. Mirrors the existing FiatToken
  `masterMinter()` handling in `mint-authority`. Pinned by the USDC fixture, which
  now asserts `pause-guardian: critical`. Unit-tested in `pause-guardian-core.ts`,
  including that an EOA `owner()` no longer forces a critical when a contract
  `pauser()` actually holds the key.
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
