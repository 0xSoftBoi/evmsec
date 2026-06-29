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

### Next (priority order)

1. **Authority depth** — extend `admin-power` with **Safe module/guard
   introspection** (an enabled module or a malicious guard is a back door around
   the threshold) and a **full privileged-role graph** (enumerate every
   AccessControl role and its members, not just the proxy admin). *Why:* the
   threshold is meaningless if a module can bypass it.

2. **`oracle-hygiene <feed>`** — for a Chainlink-style price feed, read
   `latestRoundData()` and flag **staleness** (`updatedAt` older than the feed's
   heartbeat), a **zero/negative answer**, and **single-source** designs; on L2s,
   check the **sequencer-uptime feed**. *Why:* stale/2manipulated oracles are a
   top-five DeFi loss category and are pure on-chain reads.

3. **`compiler-bugs <address>`** — read the solc version from the contract's CBOR
   metadata trailer (evmsec already parses CBOR for `pq-readiness`) and look it up
   against the official solc `bugs_by_version.json`. *Why:* known-buggy compiler
   versions (storage-corruption, ABI-encoder bugs) are a deterministic, citable
   finding with zero false positives.

4. **`delegation-safety <eoa>`** (EIP-7702) — `pq-readiness` already detects the
   `0xef0100` delegation prefix; this resolves the **delegate target** and
   classifies it (known/canonical vs unknown contract). *Why:* 7702 account
   delegation is a 2025+ phishing/drainer vector and is directly readable.

5. **`verification-status <address>`** — query Sourcify v2
   (`GET /v2/contract/{chainId}/{address}` → `exact_match` / `match` / absent),
   with an Etherscan V2 API fallback. *Why:* an unverified contract holding value
   is itself a yellow flag, and this is a clean, cacheable lookup.

6. **Drift / baseline track** — snapshot a contract's security-relevant state
   (guardian set, validator/DVN set, bytecode codehash, admin) to a committed
   baseline file and **diff on each run**, failing CI on unexpected drift. *Why:*
   the snapshot-diff pattern catches silent privileged changes that point-in-time
   checks miss; it's the cron-native complement to `solvency --watch`. Includes a
   **balance-drain tripwire** (escrow balance dropping faster than a threshold)
   and **bytecode-immutability** assertion.

7. **codehash exact-match allowlist** — a small shared primitive: assert a
   contract's `extcodehash` matches a known-good value. Underpins "this Safe is
   the canonical Gnosis singleton" and "this 7702 delegate is a vetted target."

## Distribution

The checks only matter if they're trivial to run:

- **Publish to npm** (`npx evmsec ...`) — the build already compiles to `dist/`.
- **GitHub Action** — `uses: 0xSoftBoi/evmsec-action` wrapping the CLI, so a repo
  gets bridge/admin/oracle checks in CI in three lines.
- **Docker image** — for cron / non-Node environments.
- **SARIF output** — so findings surface in the GitHub Security tab.
- **`evmsec audit <address>`** — a meta-command that runs every applicable check
  (upgradeability + admin-power + mint-authority + pause-guardian + oracle +
  verification + compiler-bugs) and prints one consolidated report card.
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
