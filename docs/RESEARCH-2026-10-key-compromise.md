# evmsec research: the key-compromise thesis and what to build next

Researched 2026-10-04. Question: given what evmsec already does (see
`docs/IMPROVEMENTS.md` for the shipped plan), where is the highest-leverage
unbuilt surface? Answer, with receipts: **authority monitoring, not more
invariant checks.** In 2026, stolen keys — not broken code — became crypto's
dominant loss vector, and evmsec's current suite watches the *effects*
(backing ratios) while the *cause* (who can sign) goes unmonitored between runs.

## 1. What the 2026 incident data says

- **TRM Labs, H1 2026**: 207 hacks (2× H1 2025). Infrastructure/key/operational
  compromises were only ~15% of incidents but **~76% of value stolen**. North
  Korea-linked actors took ~66% of stolen funds. (via AMBCrypto; HOGE Wire)
- **KelpDAO, April 2026, ~$290M**: attackers compromised a LayerZero
  developer's *session keys*, poisoned the RPC feeding the bridge's verifier
  network, and **minted 116,500 unbacked rsETH** — then posted them as Aave
  collateral, triggering a $6.28B TVL drawdown. (cryptonews.net)
- **ASI Alliance (Fetch.ai / SingularityNET / NuNet), Sept 2026, ~$20M**:
  compromised *bridge authoriser keys* → 260M AGIX + 53.8M WMTx minted without
  authorisation. (cryptotimes.io, PeckShield)
- **Drift Protocol, 2026, $285M**: months of social engineering → pre-signed
  authority via a *durable nonce* → fake token whitelisted → drained in 128s.
  No code bug; pure authority abuse. (cryptonews.net)
- **Bitget, Sept 2026, $387.5M**: backend auth spoofing, keys never taken.
  (Unbiased Headlines)
- **Bybit, Feb 2025, $1.5B**: developer workstation compromised → Safe UI
  spoofed. (AMBCrypto)
- **Liquid Network, 2026, $320M**: the rare pure-consensus-verification bug —
  the exception that proves the rule. (HOGE Wire)

Pattern: the catastrophic bridge losses of the last 18 months are
**key/authority compromises that end in unauthorized minting or drainage**.
The mint is the on-chain fingerprint. evmsec's `solvency` watches the backing
ratio (the *effect*, polling); nothing watches the *authority* continuously.

## 2. Proposals (priority order)

### P1 — `authority watch`: signer-set drift monitoring [M]

**Why.** `admin-power` answers "who controls this, and how dangerous" as a
point-in-time check. Every major 2026 incident above was a *change* in who
could sign: new validator keys (Ronin pattern), malware-added Safe owners
(Radiant pattern), compromised session keys (KelpDAO), spoofed signers
(Bybit). A point-in-time check in CI cannot see a signer set change on a
Tuesday.

**What.** Snapshot the authority-relevant state per monitored address and
diff on each run / watch tick, alerting on ANY change:
- Safe: `getOwners()` + `getThreshold()` (+ enabled modules — the roadmap's
  Safe-module item, folded in here where it matters most)
- Validator/guardian sets where readable (Wormhole guardian set index,
  bridge multisigs)
- EOA→contract transitions (an authority EOA that becomes a contract, or
  gains a 7702 delegation, is a takeover until proven otherwise)
- Baseline file committed next to `bridges.json`; `evmsec authority watch
  --baseline authority.json --webhook …` reuses the `--watch` /
  `computeTransitions` machinery (alert once per transition, recover quietly).

**Acceptance.** Changing a Safe's owners or threshold on a monitored bridge
fires exactly one alert; no alert on unchanged state; CI mode (`--check`)
fails non-zero on drift.

**Why now.** This is the single highest-ROI unbuilt check: it covers the
cause behind ~76% of stolen value, and no lightweight self-hosted tool does
it (Forta/Hypernative do it as SaaS with models; nobody does it as a cron
one-liner).

### P2 — Mint tripwire: push-based unauthorized-mint detection [S/M]

**Why.** KelpDAO's 116,500 unbacked rsETH and ASI's 260M AGIX were both
*unauthorized mints* — the exact event a backing-ratio poller sees late (or
never, if the wrapped token isn't in the registry). A mint is a single
`Transfer(address(0), …)` event: cheap to watch, unambiguous, and it fires
*before* the backing math matters.

**What.** `evmsec mints --watch --token <wrapped> [--threshold <amount>]`
subscribes to Transfer-from-zero events (push via logs subscription where the
provider supports it, falling back to the existing poll loop) and alerts on
any mint above threshold — or any mint at all when `--any-mint` is set for
tokens whose supply should only ever *burn* on that chain (the destination
side of a lock-and-mint bridge should never mint except via the bridge
contract; the minter allowlist is one address).

**Acceptance.** Replaying the KelpDAO mint txs against the tripwire fires
before any backing-ratio threshold would; zero false positives on normal
bridge mint flow in the incident-fixture harness.

### P3 — `delegation-safety`: finish the 7702 story [S]

**Why.** The roadmap lists this as Next #2; the 2026 data makes it urgent:
450k+ wallets compromised via delegation phishing, **97% of observed 7702
delegations malicious** (Wintermute), $12M+ realized (OAK cohort tracker),
and the vector has evolved from user wallets to *protocol counterparties*
(the April 2026 QNT pool drain). evmsec's `pq-readiness` detects the
`0xef0100` prefix; nobody classifies the target.

**What.** `evmsec delegation-safety <eoa>`:
1. `eth_getCode(eoa)` → strip `0xef0100` → delegate address.
2. Classify: **known-drainer** (bundled denylist — Inferno's
   `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B`, CrimeEnjoyor/CrimeMulticall
   families — each verified before bundling, per the repo's guardrails),
   **known-benign** (vetted delegation targets, codehash-allowlisted),
   **unknown** (elevated — inspect).
3. Fail closed: unknown or denylisted → non-zero exit.

**Acceptance.** Flags a delegated-to-drainer EOA as critical; passes a
clean EOA; the denylist ships with a `npm run gen:7702-denylist` refresh
script and sourcing notes (same pattern as `gen:solc-bugs`).

### P4 — `audit-bridge <route-id>`: the composite report card [S]

**Why.** All the primitives exist (`solvency`, `admin-power`,
`mint-authority`, `pause-guardian`, `verification-status`, `oracle-hygiene`,
`message-proof`). A bridge operator or integrator currently runs six
commands and correlates the output by hand. One command, one severity-ranked
report, one exit code — the same composition play that made `audit
<address>` work for contracts.

**What.** Resolve the route from `bridges.json`, run every applicable check
against the escrow, the wrapped token, and the bridge admin, and render the
unified CheckReport (human / JSON / SARIF — the framework already exists).

**Acceptance.** `evmsec audit-bridge polygon-usdc` produces a single report
covering backing, authority, mint control, pause control, verification, and
oracle; `--fail-on` gates CI.

### P5 — "Would it have caught it?" incident-replay matrix [M]

**Why.** Credibility and regression in one artifact. The repo already has the
record/replay harness (`src/testing/replay-provider.ts`). Publish a matrix:
rows = the canonical incidents (Ronin, Wormhole, Nomad, Multichain,
Radiant, KelpDAO, ASI, Bybit), columns = evmsec checks, cells = which check
fires against pre-/mid-incident state. KelpDAO is the headline: `solvency`
fires the moment 116,500 unbacked rsETH exists — provable today with the
fixture harness.

**What.** `docs/INCIDENTS.md` + a CI job that replays the pinned fixtures
through the real assessors and asserts the expected verdicts (extends
`src/incident-fixtures.test.ts`). New incidents get added as fixtures, not
prose.

**Acceptance.** CI fails if a code change silently stops a check from firing
on its canonical incident. The matrix is honest about misses (e.g. Drift's
social-engineering phase is off-chain — mark it `not coverable`, lane
discipline).

### P6 — Timelock queue inspection [S/M]

**Why.** `admin-power` reads the timelock's *delay*; nobody reads *what's
queued*. A timelock with a 48h delay and a queued `upgradeTo(attacker)`
is a breach with a countdown — currently invisible until execution.

**What.** For OZ `TimelockController` / Compound timelocks: enumerate queued
operations (`getTimestamp` / `queuedTransactions`), decode the target +
calldata where the ABI is known, and report pending privileged actions with
ETA. Pairs with P1: queue-appeared is a drift event.

**Acceptance.** Against a mainnet timelock with a queued upgrade, reports
target, function, and executable-at time; empty queue reads clean.

## 3. Smaller additions worth doing

- **DVN/guardian-set version tracking** for `message-proof`: KelpDAO poisoned
  the verifier set's *inputs*; versioning the set itself (Wormhole guardian
  set index, LayerZero DVN config) closes the loop the command currently
  leaves open.
- **Escrow allowance hygiene**: a bridge escrow holding unlimited approvals
  to unknown spenders is a sweep waiting for a key compromise — one
  `allowance()` scan over the top holders.
- **MCP surface**: `mcp.ts` exposes 2 tools; `audit_contract` is the right
  wedge for agents, but `solvency` and `admin-power` as tools would put
  evmsec inside the agent loop (suwappu's agents are the natural first
  consumers).
- **Distribution** (already in the plan, reiterating priority): npm publish
  first — `npx evmsec` is the difference between a tool people try and a
  tool people star. Docker second.

## 4. What not to build (lane discipline holds)

The incident data tempts scope creep; the doc's four-lane framing already
rules these out, and the data confirms it:
- **Drift-style social engineering / durable-nonce abuse**: off-chain; the
  honest cell in the matrix is `not coverable`.
- **Bitget-style backend spoofing**: not on-chain-readable.
- **ML anomaly detection / mempool interception**: lanes 2–3, owned by the
  SaaS platforms; evmsec's wedge is deterministic rules.

## Sources

- TRM Labs H1 2026 via AMBCrypto (207 hacks, 76% of value from key/infra
  compromise): https://ambcrypto.com/cryptos-biggest-hacks-drain-over-5b-heres-the-major-problem-they-expose/
- TRM Labs H1 2026 breakdown via HOGE Wire (15% of incidents, 76% of value):
  https://hoge.gg/private-key-compromise-2026-theft-is-the-easy-part/
- Liquid Network $320M anatomy (bridge failure taxonomy):
  https://hoge.gg/liquid-network-hack-analysis-320m-bridge-bug-2026/
- KelpDAO $290M (April 2026, session keys, 116,500 unbacked rsETH):
  https://cryptonews.net/news/security/33396919/
- ASI Alliance key compromise (Sept 2026, 260M AGIX / 53.8M WMTx):
  https://www.cryptotimes.io/2026/09/21/crypto-hacks-drain-20m-this-week-rseth-safe-nostra-fall/
- 2026 hack landscape (DropsTab): https://news.dropstab.com/research/crypto-hacks
- EIP-7702 cohort tracker (OAK, $12M+, 450k wallets):
  https://github.com/onchainattack/oak/blob/HEAD/examples/2025-05-eip7702-crimeenjoyor-delegation-phishing-cohort.md
- 7702 phishing analysis (97% malicious, Wintermute; Inferno address):
  https://github.com/fevra-dev/lure/blob/HEAD/Research/phishing_threat_intelligence_report_2026.md
- Scam Sniffer 2025 annual (via SQ Magazine):
  https://sqmagazine.co.uk/phishing-and-wallet-drainer-incidents-statistics/

## Suggested sequencing

1. **P4** (`audit-bridge`) — composition only, ships this week, makes every
   existing check more valuable.
2. **P1** (authority watch) — the thesis bet; the Watchtower already has the
   monitor/alert plumbing to reuse.
3. **P3** (delegation-safety) — small, urgent, reuses the denylist pattern
   from `gen:solc-bugs`.
4. **P2** (mint tripwire) — pairs with the Watchtower's sweep model.
5. **P5** (incident matrix) — credibility moat; grows with the fixture set.
6. **P6** (timelock queue) — forward-looking complement to P1.
