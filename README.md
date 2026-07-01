# evmsec

[![ci](https://github.com/0xSoftBoi/evmsec/actions/workflows/ci.yml/badge.svg)](https://github.com/0xSoftBoi/evmsec/actions/workflows/ci.yml)
[![bridges](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F0xSoftBoi%2Fevmsec%2Fmaster%2Fbadge.json)](./STATUS.md)
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
# once published — no clone, no build:
npx evmsec audit 0xContract --chain ethereum
npm i -g evmsec            # or install the `evmsec` / `evmsec-mcp` bins globally

# Docker (no Node needed):
docker run --rm -e ETHEREUM_RPC_URL=https://your-rpc \
  ghcr.io/0xsoftboi/evmsec audit 0xContract --chain ethereum

# from source (for development):
git clone https://github.com/0xSoftBoi/evmsec && cd evmsec && npm install
cp .env.example .env       # optional: your own RPCs / bridge registry
```

Point an `<CHAIN>_RPC_URL` env var at a reliable endpoint — the public fallbacks
are rate-limited. Releases are cut by pushing a `v*` tag: the
[`release` workflow](.github/workflows/release.yml) publishes to npm (with
provenance) and pushes the image to GHCR.

## Usage

```bash
npm run evmsec -- <command> [args]
# or: npx tsx src/index.ts <command> [args]
```

### `audit` — run every applicable check, one report card

The fastest way in: point `audit` at any contract. It fetches the bytecode
**once**, runs every check that applies to a generic contract — source
verification, compiler-bug exposure, upgradeability, admin power, mint authority,
pause guardian, freeze authority — and prints one report card, severity-ranked,
with an overall verdict.

```bash
npm run evmsec -- audit 0xContract --chain ethereum
```

```
  Report card — 0x… on Ethereum
  ────────────────────────────────────────
  ✓ ok         verification-status
  ⚠ WARNING    compiler-bugs
  ✗ CRITICAL   upgradeability
  ✗ CRITICAL   admin-power
  ⚠ WARNING    mint-authority
  ✗ CRITICAL   pause-guardian
  ✗ CRITICAL   freeze-authority
  ────────────────────────────────────────
  OVERALL: ✗ at least one critical finding — blocking.
```

Every check is one `Check` over a shared context (`src/check.ts`,
`src/checks/`), so the _same_ assessor drives both `evmsec admin-power` and the
`audit` row — no duplicated logic, no `process.exitCode` snooping. That also
means every check gets machine output for free:

- `--json` — a structured aggregate (`{ overall, counts, reports[] }`) for piping.
- `--sarif` — SARIF 2.1.0 for the [GitHub Security tab](#use-in-ci-github-action).
- `--fail-on <severity>` — exit non-zero at `critical` (default) or `warning`.

`oracle-hygiene`, `solvency`, `settlement`, and `message-proof` are intentionally
excluded — they target a feed / route / tx-pair / VAA, not a generic contract.
It's a heuristic aggregate of on-chain reads, not a substitute for an audit.

#### What it catches (regression-tested against real contracts)

The verdicts below aren't marketing — they're **pinned in a test suite**. Each
one records the exact on-chain reads against a real mainnet contract
(`scripts/capture-fixtures.ts`) and replays them offline through the real
assessors (`src/incident-fixtures.test.ts`), so a heuristic can't drift without a
test going red. Regenerate with `npm run capture:fixtures`.

_Reports a real on-chain property:_

- **USDC** (`0xA0b8…eB48`) → `admin-power: ✗ CRITICAL`. Its FiatTokenProxy upgrade
  admin (`0x807a…95d2`) is a **plain EOA** on-chain, with no on-chain timelock or
  multisig gating the upgrade (verify: that address has no code). Read this
  precisely: it means the upgrade is protected **only** by whatever off-chain key
  custody Circle uses — an EOA can be backed by MPC/HSM/multi-party signing that
  evmsec **cannot see**. The critical rating is about what's _enforced on-chain_,
  not a claim that one person holds a hot key. (See [Limitations](#limitations).)
- **USDC** also → `freeze-authority: ✗ CRITICAL` and `pause-guardian: ✗ CRITICAL`.
  Its `blacklister()` is a single EOA that can freeze any individual holder, and
  its `pauser()` is a single EOA that can freeze _all_ transfers — both correctly
  attributed to the actual role (not `owner()`). Real, live censorship surface on
  the largest regulated stablecoin.
- **USDT** and **WBTC** → `admin-power: ⚠ WARNING`. Their owners are contracts that
  are **not** a recognized Gnosis Safe or timelock, so the tool flags them for
  inspection rather than rubber-stamping "it's a contract" — it doesn't claim to
  know what those controllers are. (USDT also → `freeze-authority: ⚠ WARNING`: the
  owner can `addBlackList` **and** `destroyBlackFunds` — freeze _and burn_ any
  holder's balance.)

_Doesn't cry wolf on reasonable setups:_

- **DAI** → `upgradeability: ✓ ok` — correctly identified as **not** a proxy.
- **Ethena USDe** → `admin-power: ✓ ok`. Its controller is a real **5-of-10 Gnosis
  Safe**; the tool reads the threshold live (`getThreshold`/`getOwners`) and does
  **not** flag it — a threshold at least half the signers is an ordinary config.
  (An earlier version wrongly flagged this; the fixture now guards against it.)

_Honestly scoped where it's blind:_

- **cUSDC** → `admin-power: ⚠ WARNING (not assessed)`. Compound gates admin through
  a non-standard `admin()` getter evmsec doesn't resolve, so it reports the
  controller as **unresolved** rather than a green pass — a documented blind spot,
  pinned as one. Expect the same on DAO-governed tokens (Curve, Frax, Balancer):
  the tool doesn't understand every governance scheme and says so.

**On the Safe threshold heuristic — a deliberately weak signal.** evmsec flags a
Gnosis Safe only when the threshold is a _strict minority_ of signers (fewer than
half, e.g. 2-of-5). But threshold is a poor predictor of safety: **Ronin's bridge
was 5-of-9 — a majority — and was still drained for $625M** via key compromise,
and **Harmony's was a custom 2-of-5 that isn't even a Gnosis Safe** (evmsec would
flag it as an unrecognized controller, not via this path). Signer independence and
key custody matter far more than the ratio; the heuristic is a nudge to look, not
a verdict.

### `deps` — audit your on-chain dependencies

Your protocol has an **on-chain supply chain**: the USDC you hold, the Chainlink
feed you price off, the bridge you route through. You inherit their upgrade admin,
their freeze authority, their oracle staleness — and any of those can change under
you after you've integrated. `deps` audits every external contract you trust, from
one manifest, and rolls the results into a single CI verdict.

```bash
npm run evmsec -- deps deps.json [--fail-on warning] [--json|--sarif]
```

The manifest (`deps.json`, or `EVMSEC_DEPS`, or a path argument) lists the
contracts you depend on — see [`deps.example.json`](deps.example.json):

```json
{
  "dependencies": [
    { "label": "USDC", "chain": "ethereum", "address": "0xA0b8…eB48" },
    { "label": "Chainlink ETH/USD", "chain": "ethereum", "address": "0x5f4e…8419" }
  ]
}
```

It runs the full `audit` family against each entry and prints a per-dependency
report card + an overall roll-up. **Exit code is non-zero when any dependency has
a blocking finding** (`--fail-on` sets the bar), so a dependency quietly becoming
single-key-controlled fails your build:

```bash
evmsec deps deps.json --fail-on warning || alert "an on-chain dependency regressed"
```

This is the niche nobody occupies — a supply-chain / `npm audit` for the deployed
contracts your protocol trusts, not just your own code. `--json` / `--sarif` emit
the aggregate for CI and the GitHub Security tab.

### Use it from an AI agent — the MCP server

evmsec ships an [MCP](https://modelcontextprotocol.io) server, so an agent can ask
_"is this contract safe to interact with?"_ before signing a transaction, or fold
an on-chain-state audit into a workflow. It speaks JSON-RPC over stdio and exposes:

- **`audit_contract`** `{ address, chain? }` — runs the full audit family, returns a
  structured verdict (overall severity + per-check findings + evidence).
- **`list_supported_chains`** — the chains and their ids.

Wire it into a client's `mcpServers` config as a stdio server:

```json
{
  "mcpServers": {
    "evmsec": {
      "command": "npx",
      "args": ["-y", "evmsec-mcp"],
      "env": { "ETHEREUM_RPC_URL": "https://your-rpc" }
    }
  }
}
```

Findings come back as structured JSON with an explicit disclaimer (heuristic, and
an on-chain EOA may be MPC-backed off-chain) so the agent doesn't over-trust them.
`stdout` is the protocol channel; all logging goes to `stderr`.

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

Reports locked vs minted, the backing ratio, a **USD valuation**, and a verdict.
**Exit code is non-zero when undercollateralized**, so it drops straight into CI
or a cron:

```bash
*/5 * * * * evmsec solvency --all || alert "bridge backing breached"
```

The dollar figures — `$1.18B locked · $1.17B minted`, or the deficit on a breach —
come from **on-chain Chainlink price feeds** read at check time (no external API,
no key). Stablecoins are priced off their real `USDC/USD` / `DAI/USD` feeds rather
than assumed `== $1`, so a depeg shows in the number; WBTC values via `BTC/USD`
(the WBTC↔BTC peg is a custody assumption, independent of this backing check) and
cbETH composes `cbETH/ETH × ETH/USD`. A price hiccup never masks the backing
verdict — the USD fields simply drop out.

**`bridges.json` ships with real, live-verified routes** so `solvency --all`
works out of the box — 9 routes across **Polygon PoS, Arbitrum, OP Mainnet, and
Base** (USDC / DAI / WBTC / LINK / cbETH), each checked to be `BACKED`
(locked ≥ minted, ~100%) before inclusion, with its escrow linked in `notes`. Add
your own (or point `EVMSEC_BRIDGES` at a private file); `npm run validate:registry`
enforces shape, checksummed addresses, and a cited source. ⚠️ Escrows and mappings
**change** — re-verify against each bridge's own contracts before relying on a
number. A security tool fed the wrong escrow lies confidently (which is why
USDT-on-Polygon, where the standard predicate isn't the real escrow, was tested and
left out rather than shipped as a false alarm).

📊 **[`STATUS.md`](STATUS.md) is a live "is every bridge backed right now?" page** —
generated by `npm run gen:status` (which formats `solvency --all` as a table) and
refreshed every 6 hours by the [`bridge-status` workflow](.github/workflows/bridge-status.yml).
The same run also emits a machine-readable feed ([`STATUS.json`](STATUS.json)) and a
[shields.io](https://shields.io) endpoint ([`badge.json`](badge.json)) — that's the live
**bridges** badge at the top of this page. It commits the artifacts back only when the
numbers change. That's the standalone bridge-watch the ecosystem doesn't have as open
source, in ~60 lines.

Consume the feed from anywhere — e.g. your own monitor or dashboard:

```bash
curl -s https://raw.githubusercontent.com/0xSoftBoi/evmsec/master/STATUS.json \
  | jq '.overall, (.routes[] | select(.verdict != "BACKED"))'
```

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
going under, or recovering) — steady state is silent, so it won't spam. Add
`--delta <pp>` to also alert on a **sudden drop** in backing (by that many
points) even while a route is still above the threshold. Optional `--webhook`
POSTs a JSON alert; clean shutdown on Ctrl-C.

```bash
npm run evmsec -- solvency --all --watch --interval 60 --delta 5 --webhook https://hooks.example/bridge
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

### `admin-power` — who controls it, and how dangerous is that control?

`upgradeability` tells you _whether_ a contract has an admin and resolves _who_
it is. `admin-power` answers the question that actually decides the blast radius:
**what _kind_ of authority is that, and is it a single point of failure?** A
contract address as the admin is not reassuring on its own — a "multisig" that's
really 1-of-N is one key, and a timelock with a zero delay gives you no window to
react to a malicious upgrade.

```bash
npm run evmsec -- admin-power 0xProxy --chain ethereum [--min-delay 48] [--json]
```

It resolves the controlling authority (EIP-1967 / legacy proxy admin slot, else
`owner()`) and classifies it from on-chain reads:

- **EOA** — a single externally-owned key → `critical`, fails CI.
- **Gnosis Safe** — reads `getThreshold()` / `getOwners()`. A `1-of-N` Safe is
  effectively a single key → `critical`, fails CI; an `m-of-n` (m ≥ 2) reads
  `info` with the threshold shown.
- **Timelock** — reads `getMinDelay()` (OZ `TimelockController`) or `delay()`
  (Compound-style). A delay of 0 or below the `--min-delay` floor (default 24h)
  is `elevated` — too short an exit window; at/above the floor it's `info`.
- **Unrecognized contract** — `elevated`: it may be a `ProxyAdmin` or custom
  controller; inspect it (re-run on its `owner()`).
- **Zero address** — renounced.

```bash
evmsec admin-power 0xProxy --min-delay 48 || alert "proxy is single-key controlled"
```

Honestly scoped like the others: a heuristic from on-chain reads, not a proof of
the full privileged-role set — confirm against source. Pure classification logic
(`authority-core.ts`) is unit-tested offline.

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
when present, so bounded inflation reads differently from uncapped. For
**FiatToken** (USDC-class) tokens it resolves the `masterMinter()` that actually
gates minting and classifies it. **Exit code is non-zero when an inflatable
supply sits under a single EOA**, so it drops into CI alongside `solvency`:

```bash
evmsec mint-authority 0xWrappedToken || alert "wrapped token mint is single-key controlled"
```

Honestly scoped like the others: a bytecode + on-chain-read heuristic, not a
proof. Role enumeration is best-effort (a public RPC that caps `getLogs` ranges
may return an incomplete set — the tool says so). It resolves a `masterMinter`
indirection where present, but always tells you to confirm the gating against
source. The detection logic (`mint-authority-core.ts`) is unit-tested offline.

### `pause-guardian` — can transfers be frozen, and who holds the key?

Many bridge tokens are Pausable. A single key that can pause a wrapped asset can
halt every holder at once — a liveness / censorship vector. This asks: **is the
token pausable, is it paused right now, and who holds the pause authority?**

```bash
npm run evmsec -- pause-guardian 0xWrappedToken --chain polygon [--json]
```

Same shape as `mint-authority`: follows the proxy, detects the Pausable surface
and auth model, reads `paused()` to report the **current** state, and resolves
the guardian. It resolves the _actual_ pause authority rather than assuming
`owner()`:

- **FiatToken (USDC-class)** — a `pauser()` getter gates pausing, **not**
  `owner()`. The check reads and classifies `pauser()` directly (USDC's is a
  single EOA — a real single-key freeze authority, correctly attributed to the
  pauser, not the owner).
- **OpenZeppelin AccessControl** — enumerates the `PAUSER_ROLE` holders.
- **Ownable** — reads `owner()`.

**Exit code is non-zero when a single EOA can freeze transfers.** A
currently-paused token is flagged prominently regardless of who holds the key.
Heuristic, honestly scoped; logic in `pause-guardian-core.ts` is unit-tested. (Off-chain
key custody still applies — see [Limitations](#limitations).)

### `freeze-authority` — can an individual holder be frozen or seized?

`pause-guardian` covers freezing _everyone at once_. This is the targeted
censorship sibling: **can a specific holder be frozen — or their balance burned —
and who holds that power?** Two dominant on-chain patterns:

- **FiatToken (USDC-class)** — a `blacklister` role can `blacklist(addr)`. The
  check resolves `blacklister()` and classifies it.
- **Tether (USDT)** — an owner-gated `addBlackList(addr)`, plus
  `destroyBlackFunds(addr)` which **burns** a blacklisted balance (a seize, not
  just a freeze). The check resolves `owner()` and flags whether seizure is
  possible.

```bash
npm run evmsec -- freeze-authority 0xToken --chain ethereum [--json]
```

**Exit code is non-zero when a single EOA can freeze/seize any holder.** On USDC
this reports the `blacklister()` — a single EOA that can freeze any account; on
USDT it reports the owner contract and notes that balances can be seized. Tokens
without a recognized blacklist pattern read `ok`. Same on-chain-authority caveat
as the other keys (see [Limitations](#limitations)); logic in `freeze-core.ts` is
unit-tested.

### `oracle-hygiene` — is this price feed fresh and safe to read right now?

A stale or broken price feed is one of the most common DeFi loss causes: a
protocol that reads `latestRoundData()` and trusts it will price collateral off a
number that stopped updating hours ago, went to zero, or was frozen while an L2
sequencer was down. Each of those is an on-chain-readable invariant.

```bash
npm run evmsec -- oracle-hygiene 0xFeed --chain ethereum --heartbeat 3600 [--json]
# on an L2, also check the sequencer-uptime feed:
npm run evmsec -- oracle-hygiene 0xFeed --chain arbitrum --sequencer 0xSeqUptimeFeed
```

Pulls the latest round (Chainlink-style aggregator) and flags:

- **staleness** — the answer is older than `--heartbeat` (default 3600s) →
  `critical`, fails CI;
- **zero / negative answer** — never a valid price → `critical`, fails CI;
- **incomplete round** — `updatedAt == 0` → `critical`;
- **carried-over round** — `answeredInRound < roundId` → `elevated`;
- **L2 sequencer** — with `--sequencer <uptime-feed>`, a sequencer reported
  **down** is `critical` (a fresh-looking price means nothing if the chain it
  priced was offline), and one that only just restarted (within `--grace`,
  default 1h) is `elevated`.

Staleness is measured against the chain's own latest-block timestamp, not wall
clock. **Freshness/liveness only** — this can't attest the price is _correct_ or
sourced from enough nodes; that's a different lane. Pure logic in
`oracle-core.ts` is unit-tested offline.

### `compiler-bugs` — built with a solc version that has a known bug?

Solidity ships with bugs, and the team publishes _exactly which compiler versions
each one affects_. A contract's bytecode usually carries the exact solc version
it was built with in its CBOR metadata trailer — so "was this compiled with a
version subject to a known bug?" is a fully deterministic, on-chain-readable
question.

```bash
npm run evmsec -- compiler-bugs 0xContract --chain ethereum [--json]
```

Reads the solc version from the metadata (following the proxy to its
implementation, since that's where the logic and its compiler live) and matches
it against the Solidity team's own `bugs.json` / `bugs_by_version.json`
(bundled — regenerate with `npm run gen:solc-bugs`). Each finding links to the
official writeup.

**In practice this is a warning-level check, and the README should say so.** A
bug being present in the compiler version is necessary but not sufficient — most
bite only under specific compile settings (`viaIR`, optimizer, `evmVersion`) that
can't be read from bytecode, so they read `⚠ WARNING (verify)` with the
conditions surfaced. In fact _every_ high-severity solc bug from the CBOR-metadata
era (≥0.4.22) is condition-gated, so the `critical` / non-zero-exit path — though
implemented and tested — effectively never fires for a real modern contract. Use
this to learn "your compiler is subject to X, go check the conditions," not as a
hard gate. A contract that strips metadata, is Vyper/assembly, or predates CBOR
tags reports "version not found" rather than guessing. Pure logic in
`compiler-core.ts` is unit-tested offline.

### `verification-status` — is this contract's source verified?

A contract holding value whose source isn't verified anywhere is a yellow flag in
its own right: nobody can review what the bytecode actually does, and every other
evmsec check is working from bytecode alone.

```bash
npm run evmsec -- verification-status 0xContract --chain ethereum [--json]
```

Queries Sourcify v2 (`GET /v2/contract/{chainId}/{address}`) and classifies the
result: a full **exact match**, a **partial match** (bytecode matches but the
metadata hash differs — functionally verified), or **unverified**. **Exit code is
non-zero when no verified source is found.** A provider that's unreachable reads
`unknown` (a network condition, not a verdict) and does _not_ fail CI. Override
the server with `--sourcify <url>`; the HTTP timeout is `EVMSEC_HTTP_TIMEOUT_MS`.
Pure classification (`verification-core.ts`) is unit-tested offline.

### `settlement` — did the cross-chain intent actually get filled?

Decode an intent on the source chain to learn what the filler _promised_ to
deliver, then check the `fill` tx really delivered that token and amount to the
intended recipient, before the deadline, and final. The decoder is pluggable via
`--protocol` (default ERC-7683):

| `--protocol` | intent event                          | notes                                                                                       |
| ------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `erc7683`    | `Open` (`maxSpent`)                   | the [ERC-7683](https://eips.ethereum.org/EIPS/eip-7683) standard; cross-chain               |
| `across`     | `FundsDeposited` / `V3FundsDeposited` | Across SpokePool; cross-chain                                                               |
| `cow`        | `Trade` (batch)                       | CoW Protocol; **same-chain** — pass the settlement tx as both `--intent-tx` and `--fill-tx` |

```bash
# ERC-7683 / Across (cross-chain)
npm run evmsec -- settlement --protocol across \
  --source-chain ethereum --intent-tx 0xDepositTx \
  --fill-tx 0xFillTx [--dest-chain base] [--finality-depth 12] [--json]

# CoW (same-chain: one settlement tx is both sides)
npm run evmsec -- settlement --protocol cow \
  --source-chain ethereum --intent-tx 0xSettleTx --fill-tx 0xSettleTx
```

Per output it reports `settled` / `unsettled` / `anomaly` and exits non-zero on
anything but a clean settlement — catching missing fills, wrong-recipient fills,
late fills, and underfills.

**`settlement diagnose`** is the forensic counterpart for an intent that _should_
have settled but didn't. Without needing a fill tx, it scans the destination for
the expected token's deliveries to the recipient and classifies the failure
mode — `never-filled`, `underfilled`, `filled-late`, or `settled` — with the
on-chain evidence (the completing tx, how late, how short):

```bash
npm run evmsec -- settlement diagnose --protocol across \
  --source-chain ethereum --intent-tx 0xDepositTx [--scan-blocks 50000] [--json]
```

Honestly scoped. Each decoder reads the protocol's own deposit/trade event (ABIs
from the official contracts) and verifies ERC-20 deliveries via Transfer logs;
native-token outputs are flagged, not proven. **Omit `--fill-tx` to
auto-discover it**: the tool scans the last `--scan-blocks` (default 50k) of the
destination for the matching delivery (chunked to survive node `getLogs` caps)
and picks the earliest tx that satisfies the output — falling back to a clear
message when it can't, so you can pass `--fill-tx` or widen the window. Limits:
**UniswapX** isn't supported — its `Fill` event carries no output amounts, so the
promise can't be read from logs alone (it needs the signed order / calldata —
roadmap). CoW verifies delivery to the order `owner` (the `Trade` event omits an
optional `receiver`). It does **not** cryptographically verify cross-chain
message proofs. Decoders are unit-tested offline; **validate a new protocol
against a real settlement before trusting a number.** Treat it as a settlement
_audit helper_, not an oracle.

### `message-proof` — was the cross-chain message validly attested?

`settlement` confirms a token _delivery_. The stronger guarantee is that a
_validly attested message_ actually crossed the messaging layer. This checks the
attestation directly on the destination chain (a single `eth_call`, no logs):

| `--layer`   | check                                                        | you supply                  |
| ----------- | ------------------------------------------------------------ | --------------------------- |
| `hyperlane` | `Mailbox.delivered(messageId)` — passed its ISM and executed | `--id <bytes32 message id>` |
| `wormhole`  | `Core.parseAndVerifyVM(vaa)` — guardian signatures valid     | `--vaa <0x encoded VAA>`    |

```bash
npm run evmsec -- message-proof --layer hyperlane --chain base --id 0xMessageId
npm run evmsec -- message-proof --layer wormhole  --chain ethereum --vaa 0x01000000... --json
```

**Exit code is non-zero unless the message is confirmed verified**, so an
unattested or unrelayed message fails a CI gate. Core Wormhole / Hyperlane
contract addresses are bundled for ethereum, base, arbitrum, optimism, and
polygon (each verified live before bundling); override with `--contract` for
other chains. It distinguishes "tokens arrived" from "tokens arrived **and** the
message was validly attested" — a tampered VAA reads `UNVERIFIED` (the guardian
signatures fail on-chain), not a false pass. **LayerZero** isn't supported yet:
verifying a specific message's DVN attestation needs the full Origin/nonce
context and the receiver's configured DVN set, not a single view call (roadmap).
The VAA parser and verdict classifiers (`message-proof-core.ts`) are unit-tested.

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

## Limitations

evmsec reads on-chain state and applies opinionated rules. That's its whole
value — and its ceiling. Be clear-eyed about what it **cannot** see:

- **An EOA on-chain ≠ a single hot key.** When an admin/owner is an EOA, evmsec
  reports single-key control because that's what's _enforced on-chain_. But that
  address may be an MPC/HSM/threshold-signing setup off-chain (Fireblocks and
  similar) requiring multiple approvals. evmsec can't observe off-chain custody,
  so `critical` here means "no on-chain multisig/timelock," not "one person can
  rug this tomorrow."
- **Multisig threshold is a weak predictor.** Ronin (5-of-9, a majority) was
  drained for $625M; Harmony (2-of-5, and not even a Gnosis Safe) for ~$100M. A
  healthy-looking ratio says little about signer independence, key custody, or
  social-engineering exposure. Treat the Safe check as a nudge, not a verdict.
- **Governance evmsec doesn't resolve → `warning (not assessed)`, not a finding.**
  It resolves EIP-1967 proxy admins and `owner()`. Contracts governed by a DAO
  (Aragon/Governor), AccessControl roles, or a non-standard `admin()`
  (Compound-style) come back **unresolved** — flagged for manual review, which is
  fail-closed, not an accusation. Curve, Frax, Balancer, and cUSDC all land here.
- **`compiler-bugs` is warning-level in practice.** Every high-severity solc bug
  in the CBOR-metadata era (≥0.4.22) is _conditional_ on compile settings evmsec
  can't read from bytecode (viaIR/optimizer/ABIEncoderV2). So the `critical`
  (unconditional-high) path effectively never fires for a real modern contract —
  the useful output is the warning-level "this version is subject to X; verify."
- **Bytecode heuristics aren't proofs.** Mint/pause/upgrade detection scans the
  dispatcher for selectors and reads a few slots. It can miss non-standard
  patterns and can't reason about custom logic. Every verdict says "confirm
  against source" because you should.
- **Role enumeration is best-effort.** `MINTER_ROLE`/`PAUSER_ROLE` holders come
  from AccessControlEnumerable or `RoleGranted` history; a public RPC that caps
  `getLogs` ranges can return an incomplete set (the tool says when it does).

None of this is a reason not to run it — a fast, honest, on-chain-property check
in CI catches real regressions. It _is_ a reason not to treat a clean run as an
audit.

## Use in CI (GitHub Action)

Every check exits non-zero on a failing verdict, which is the whole point: drop
it into a workflow and a regression fails the build. A composite action ships in
this repo ([`action.yml`](action.yml)) — it builds evmsec from source, so it
works without an npm release:

```yaml
# .github/workflows/security.yml
name: security
on: [push, schedule]
jobs:
  evmsec:
    runs-on: ubuntu-latest
    steps:
      - uses: 0xSoftBoi/evmsec@main
        with:
          args: "audit 0xYourContract --chain ethereum"
        env:
          ETHEREUM_RPC_URL: ${{ secrets.ETHEREUM_RPC_URL }}
```

Run any command via `args` — `audit 0x…`, `solvency --all`, `oracle-hygiene 0xFeed
--chain arbitrum --sequencer 0x…`. Point an RPC env var at a reliable endpoint
(public RPCs are rate-limited). Without the Action you can equally
`npx tsx src/index.ts <command>` or, once published, `npx evmsec <command>` in
any `run:` step.

**Findings in the Security tab.** Every contract-audit command (`audit`,
`admin-power`, `mint-authority`, …) takes `--sarif`, so you can surface findings
as GitHub code-scanning alerts instead of digging through logs:

```yaml
jobs:
  evmsec:
    runs-on: ubuntu-latest
    permissions:
      security-events: write # required to upload SARIF
    steps:
      - uses: 0xSoftBoi/evmsec@main
        with:
          args: "audit 0xYourContract --chain ethereum --sarif > evmsec.sarif"
        env:
          ETHEREUM_RPC_URL: ${{ secrets.ETHEREUM_RPC_URL }}
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: evmsec.sarif
```

Use `--fail-on warning` to make warnings (not just criticals) block the build,
or `--json` for a structured aggregate to pipe elsewhere.

## Layout

```
src/
  config.ts                  chains, RPCs
  lib.ts                     provider cache + RPC retry/concurrency, ABIs, proxy slots, math, bisection
  lib.test.ts                unit tests for the pure logic (no network)
  solvency-core.ts           pure backing summation, breach predicate, watch transitions
  registry-core.ts           pure bridges.json validator (shape, chains, checksums, sources)
  discovery-core.ts          pure fill-tx selection + getLogs range chunking
  diagnose-core.ts           pure settlement failure-mode classification
  message-proof-core.ts      pure VAA-header parsing + attestation classifiers
  message-layers/            per-layer attestation verifiers (Hyperlane, Wormhole)
  settlement-core.ts         pure delivery-matching + verdict logic (protocol-agnostic)
  protocols/                 pluggable settlement decoders (Protocol interface; erc7683, across, cow)
  pq-core.ts                 pure post-quantum scheme classification (bytecode → verdict)
  authority-core.ts          pure authority classification (EOA / Safe / timelock → verdict)
  oracle-core.ts             pure price-feed hygiene (staleness / zero / sequencer → verdict)
  compiler-core.ts           pure solc-version extraction (CBOR) + bug-list matching
  data/solc-bugs.ts          bundled solc bug lists (derived; npm run gen:solc-bugs)
  verification-core.ts       pure source-verification verdict (Sourcify match → verdict)
  mint-authority-core.ts     pure mint/auth capability classification (bytecode → verdict)
  pause-guardian-core.ts     pure pause capability + guardian classification
  freeze-core.ts             pure blacklist/freeze capability + authority classification
  *-core.test.ts             unit tests for the pure cores (no network)
  check.ts                   the check framework: Finding/Report types + human/JSON/SARIF renderers
  deps-core.ts               pure dependency-manifest validation (shape / chains / addresses)
  mcp.ts                     MCP server entrypoint (evmsec-mcp) — audit_contract over stdio
  checks/                    one assessor per contract-audit check (over the pure cores)
    run.ts                   shared runner + assessTarget (fetch bytecode once → run checks)
    registry.ts              the contract-audit family (what `audit` runs)
    onchain.ts               shared on-chain reads (proxy/authority/Safe/timelock probes)
    {upgradeability,authority,compiler,verification,mint,pause,freeze}.ts
  testing/replay-provider.ts record/replay provider (test-only; excluded from the build)
  fixtures/incidents/*.json  pinned real-contract reads + expected verdicts (offline replay)
  incident-fixtures.test.ts  replays the fixtures through the real assessors, no network
  bridges.ts                 route registry loader
  commands/                  thin CLI wrappers (each runs one check, or the whole family)
    audit.ts                 meta-command: run every applicable check → report card
    deps.ts                  audit your on-chain dependencies from a deps.json manifest
    solvency.ts              flagship: lock-vs-mint backing check
    upgradeability.ts        EIP-1967 / legacy proxy admin risk
    admin-power.ts           what kind of authority controls it (EOA/Safe/timelock)?
    mint-authority.ts        who can inflate the wrapped supply?
    pause-guardian.ts        who can freeze transfers?
    freeze-authority.ts      who can freeze/seize an individual holder? (blacklist)
    oracle-hygiene.ts        is this price feed fresh & safe to read now?
    compiler-bugs.ts         built with a solc version that has a known bug?
    verification-status.ts   is this contract's source verified? (Sourcify)
    settlement.ts            cross-chain intent fill verification (erc7683/across/cow)
    message-proof.ts         cross-chain message attestation (Wormhole/Hyperlane)
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
npm run capture:fixtures   # re-record the incident fixtures from live mainnet
npm run build         # compile to dist/ (what `prepublishOnly` ships)
```

The backing math, the multi-asset summation, the forensic bisection, the
`--watch` transition/degrade logic, the registry validator, the proxy-slot
parsing, the PQ / authority / mint-authority / pause-guardian / oracle-hygiene
classifiers, the settlement
decoders + fill-discovery + diagnosis, the VAA parser / attestation classifiers,
and the RPC retry/concurrency helpers are unit-tested and run offline.

**Incident fixtures.** The end-to-end verdicts are regression-tested against
_real mainnet contracts_ without a network: `scripts/capture-fixtures.ts` records
the exact on-chain reads (via a `_perform`-level recording provider) against
named contracts and pins the expected severity; `src/incident-fixtures.test.ts`
replays those reads through the real assessors offline. So "USDC's proxy admin is
a single key" and "DAI isn't a proxy" are asserted facts, not prose — and a
drifting heuristic fails CI. Test discovery is explicit (`scripts/run-tests.mjs`)
so it behaves identically across shells and Node versions. CI (`.github/workflows/ci.yml`) runs lint, format,
typecheck, and build once, plus the test suite on Node 20 and 22, for every push
and PR.

## Supply chain / Security

A security tool should be transparent about its own dependencies. evmsec ships
a **CycloneDX** Software Bill of Materials (SBOM) enumerating every npm
dependency, checked in at [`sbom/evmsec.cdx.json`](./sbom/evmsec.cdx.json) and
regenerated per release:

```bash
npx --yes @cyclonedx/cyclonedx-npm \
  --output-format JSON --output-file sbom/evmsec.cdx.json
```

In CI (`.github/workflows/`), pinned-by-SHA workflows provide **continuous OSS
scanning + a published SBOM**:

- `sbom.yml` — regenerates the CycloneDX SBOM and attaches it as a release
  asset on every published release.
- `scorecard.yml` — runs [OpenSSF Scorecard](https://securityscorecards.dev/)
  weekly and on push, writing results to the repository's Security tab.

Every third-party Action is pinned to a full commit SHA. These workflows are
present and ready; they begin running once GitHub Actions billing is enabled for
the org. This is supply-chain hygiene and dependency transparency — not a formal
security audit or a SOC 2 attestation.

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
