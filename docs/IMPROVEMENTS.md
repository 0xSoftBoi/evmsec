# evmsec — research-grounded improvement plan

This document captures the plan that came out of researching the on-chain
security tooling landscape (Hexagate, Hypernative, Forta, Blockaid, BlockSec
Phalcon, OpenZeppelin Defender/Monitor, Tenderly) and the recurring findings in
2024–2026 incidents and auditor checklists. It records **where evmsec fits**,
**what's worth building next** (and why each is in scope), and **the debt to pay
down**. It is deliberately honest about scope — evmsec asserts only what it can
read on-chain.

## Where evmsec fits

Security signals split into four lanes:

1. **On-chain-readable invariants** — state and bytecode you can verify with
   plain RPC calls and a clear rule (is this bridge backed? is the admin a single
   key? is this oracle stale?). Deterministic, explainable, no dataset required.
2. **ML / anomaly detection** — statistical models over historical activity
   (Forta bots, Hexagate, Hypernative).
3. **Mempool / pre-sign simulation** — intercept a tx before it lands
   (Blockaid, Tenderly, transaction firewalls).
4. **Off-chain indexer / dataset** — label feeds, sanctions lists, fund-flow
   graphs.

**evmsec's lane is (1), and only (1).** That's the strategic wedge: a
lightweight, self-hosted, dependency-light CLI that emits an opinionated verdict
and a **non-zero exit code**, so it drops into CI and cron next to your tests —
not a SaaS dashboard, not a model you have to trust, not a service that sees your
traffic. The closed platforms own lanes 2–4; nobody owns "the `shellcheck` /
`npm audit` of on-chain security." That's the gap.

This positioning also dictates what we *don't* build: anything that needs a
trained model, a proprietary dataset, or privileged mempool access is out of
lane. Every check below is a pure rule over public on-chain reads.

(Timely tailwind: **OpenZeppelin Defender's monitoring is shutting down July 1,
2026.** Self-hosted, code-defined alternatives have a real moment.)

## The check gaps worth filling

Each is on-chain-readable, maps to a recurring real-world failure, and follows
the existing pure-core + thin-command architecture (`*-core.ts` unit-tested
offline; `commands/*.ts` does I/O and exits non-zero on a failing verdict).

### Shipped

- **`admin-power`** — classifies the controlling authority (EOA / Safe m-of-n /
  timelock / unrecognized contract / renounced) and flags single-key control.
  Closes the "who, and how dangerous" half of the centralization question that
  `upgradeability` only half-answered. See `authority-core.ts`.
- **`oracle-hygiene`** — reads a Chainlink-style `latestRoundData()` and flags
  staleness past the heartbeat, a zero/negative answer, an incomplete or
  carried-over round, and (on L2s, via `--sequencer`) a down/just-restarted
  sequencer. See `oracle-core.ts`. *Still open:* single-source detection (needs
  the aggregator's oracle count) and a deviation check against a second feed.
- **`compiler-bugs`** — extracts the exact solc version from the bytecode's CBOR
  metadata trailer and matches it against the Solidity team's bundled
  `bugs.json` / `bugs_by_version.json` (regenerated with `npm run gen:solc-bugs`).
  Fails CI on an unconditional high-severity bug; condition-gated bugs surface
  their conditions and read elevated. See `compiler-core.ts`, `data/solc-bugs.ts`.
- **`verification-status`** — queries Sourcify v2 and classifies the result as an
  exact match, a partial match, or unverified (fails CI); an unreachable provider
  reads `unknown` rather than failing. See `verification-core.ts`. *Still open:*
  an Etherscan V2 API fallback (needs a user-supplied key).

### Next (priority order)

1. **Authority depth** — extend `admin-power` with **Safe module/guard
   introspection** (an enabled module or a malicious guard is a back door around
   the threshold) and a **full privileged-role graph** (enumerate every
   AccessControl role and its members, not just the proxy admin). *Why:* the
   threshold is meaningless if a module can bypass it.

2. **`delegation-safety <eoa>`** (EIP-7702) — `pq-readiness` already detects the
   `0xef0100` delegation prefix; this resolves the **delegate target** and
   classifies it (known/canonical vs unknown contract). *Why:* 7702 account
   delegation is a 2025+ phishing/drainer vector and is directly readable.

3. **Drift / baseline track** — snapshot a contract's security-relevant state
   (guardian set, validator/DVN set, bytecode codehash, admin) to a committed
   baseline file and **diff on each run**, failing CI on unexpected drift. *Why:*
   the snapshot-diff pattern catches silent privileged changes that point-in-time
   checks miss; it's the cron-native complement to `solvency --watch`. Includes a
   **balance-drain tripwire** (escrow balance dropping faster than a threshold)
   and **bytecode-immutability** assertion.

4. **codehash exact-match allowlist** — a small shared primitive: assert a
   contract's `extcodehash` matches a known-good value. Underpins "this Safe is
   the canonical Gnosis singleton" and "this 7702 delegate is a vetted target."

## Distribution

The checks only matter if they're trivial to run:

- ✅ **Check framework** — *shipped.* The contract-audit checks are unified behind
  one `Check` contract over a shared context (`src/check.ts`, `src/checks/`):
  bytecode is fetched once and reused, each check returns a structured
  `CheckReport`, and a single runner renders human / JSON / SARIF. This removed
  the per-command duplication and the `audit` `process.exitCode` hack.
- ✅ **`evmsec audit <address>`** — *shipped.* Runs the whole contract-audit family
  over the shared context and prints one severity-ranked report card; `--fail-on`
  controls the exit threshold. See `commands/audit.ts`, `checks/registry.ts`.
- ✅ **SARIF output** — *shipped.* Every contract-audit command takes `--sarif`
  (SARIF 2.1.0), so findings surface as GitHub code-scanning alerts. README has a
  workflow that uploads it.
- ✅ **GitHub Action** — *shipped.* A composite `action.yml` runs any evmsec
  command via an `args` input and builds from its own checkout, so it works
  without an npm release (`uses: 0xSoftBoi/evmsec@main`). A failing check fails
  the job; README documents a ready-to-paste workflow.
- **Publish to npm** (`npx evmsec ...`) — the build already compiles to `dist/`
  with a `bin`; this is an external publish step (needs npm auth / a release tag).
- **Docker image** — for cron / non-Node environments.
- **Seed `bridges.json`** with several real, source-cited verified routes.

## Validation debt

The pure cores are unit-tested offline; the `getLogs`-bound and live-call paths
are not covered in CI (the sandboxed environment restricts `eth_getLogs` and some
public RPCs are flaky). To pay down:

- An **opt-in network test suite** (gated behind an env flag) for the
  log-scanning features: `solvency --since` bisection, settlement fill
  auto-discovery, `settlement diagnose`, and role-holder enumeration.
- **Real-tx fixtures** for the Across and CoW decoders (round-trip tests confirm
  they match their declared ABIs; a captured mainnet settlement would confirm the
  decode end-to-end).
- Live-validate each new check against a known mainnet instance before shipping
  (as was done for `message-proof`, the timelocks, and `admin-power`).

## Guardrails carried into every addition

- Never assert "safe" from bytecode or a single read — report
  `verified` / `unverified` / `unknown`, mark heuristics as heuristics.
- Pure logic lives in a `*-core.ts` and is unit-tested with no network.
- Every check that can fail emits a non-zero exit code so it composes in CI.
- Bundled addresses/ABIs are verified live before they're baked in.
