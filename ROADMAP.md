# evmsec roadmap

Each item below is grounded in what already exists (so we build the _unpackaged_
slice, not a duplicate) and scoped with an approach + acceptance criteria.
Effort: **S** ≈ a day, **M** ≈ a few days, **L** ≈ a week+.

---

## 1. `mint-authority <token>` — who can mint this token? ✅ **shipped**

An ERC-20 whose mint is controlled by a single EOA is one key away from infinite
issuance — the same trust question `upgradeability` asks for proxies.

Shipped in `mint-authority` / `mint-authority-core.ts`: follows the proxy to its
implementation, scans bytecode for mint/burn/pause entrypoints and the auth model
(Ownable vs AccessControl), reads `owner()` and classifies it
(renounced / EOA / contract), and exits non-zero when an inflatable supply sits
under a single EOA. Pure classification logic is unit-tested.

**Still open (follow-ups).**

- Enumerate `MINTER_ROLE` holders from `RoleGranted` events (bytecode can't list them).
- Detect a supply cap (`cap()` / `maxSupply()`) and flag uncapped + mintable.
- Resolve a `masterMinter`-style indirection where minting isn't gated by `owner()`.

## 2. `solvency --watch` — alert the moment backing breaks **[M]**

**Why.** Real-time bridge-backing monitoring exists only as managed platforms
(Hexagate, Forta, OZ Defender) or heavy infra; a lightweight self-hosted poller
is the open slot (confirmed by the gap audit).

**Approach.** Poll on an interval (re-run `solvency` per route), or subscribe to
escrow `Transfer` + supply changes; alert via exit code / stdout / webhook when a
route drops below `--min-ratio` or degrades by `--delta`. De-dupe alerts.

**Acceptance.** `evmsec solvency --watch --interval 60 [--webhook URL]` runs a
loop and fires once per breach transition; clean shutdown on SIGINT.

## 3. Multi-asset bridges — sum escrows across many tokens **[M]**

**Why.** Real bridges lock many assets in one (or several) escrows; today a
route is one asset.

**Approach.** Extend `Route` to accept arrays of `{escrow, token}` on the lock
side and multiple wrapped tokens on the mint side; normalize and aggregate;
report per-asset backing **and** an aggregate. Backward-compatible with the
single-asset shape.

**Acceptance.** A multi-asset route reports each asset's backing plus a total;
existing single-asset routes are unaffected.

## 4. Community-verified `bridges.json` registry **[S]**

**Why.** The registry is only trustworthy if every address traces to a primary
source — and that should be machine-enforced, not just documented.

**Approach.** A JSON Schema for `bridges.json` + a `validate-registry` script
wired into CI (checksummed addresses, known chains, a source URL in `notes`).
Move routes into a `routes/` dir if it grows. PR template requiring the source.

**Acceptance.** CI fails a registry PR that lacks a cited source or has a
malformed/unchecksummed address; ships with several verified real routes.

## 5. `settlement`: more intent formats **[L]**

**Why.** v1 is ERC-7683 only; the live volume is in protocol-specific formats,
each with **distinct events**:

- **Across** — `FundsDeposited` (origin) ↔ `FilledRelay` / `FilledV3Relay` (dest)
- **UniswapX** — on-chain Reactor `Fill` events (Dutch orders)
- **CoW Protocol** — `GPv2Settlement` `Trade` events (batch settlement)

**Approach.** A `Protocol` decoder interface — `parseIntent(tx)` and
`parseFill(tx)` → normalized `{ recipient, token, amount, deadline }` — with one
module per protocol under `src/protocols/`. `--protocol across|cow|uniswapx|erc7683`.

**Acceptance.** Each protocol verifies a real mainnet settlement; the core
delivery-matching logic is reused unchanged.

## 6. `settlement`: auto-discovery of the fill tx **[M]**

**Why.** v1 makes the user supply `--fill-tx`. Auto-discovery is the convenience
that makes it usable for auditing arbitrary intents.

**Approach.** Given the intent's `orderId`/recipient, scan the destination for
the matching fill (by `orderId` topic, or recipient transfer) over a bounded
window; for production use, an optional indexer/Etherscan-API backend. Degrade
gracefully and warn when a scan exceeds RPC log-range limits.

**Acceptance.** `settlement` resolves the fill without `--fill-tx` for recent
intents; clearly reports when it can't and falls back to manual.

## 7. `settlement`: cross-chain message-proof verification **[L]**

**Why.** v1 confirms a _token delivery_, not that a _valid attested message_
crossed. The strongest settlement guarantees come from the messaging layer.

**Approach.** Per-bridge proof checks: Wormhole **VAA**, LayerZero **DVN**
attestation, Hyperlane **ISM**/mailbox `delivered`. Set `messageVerified=true`
only when the underlying attestation is confirmed on the destination.

**Acceptance.** For a supported messaging layer, the verdict distinguishes
"tokens arrived" from "tokens arrived _and_ the message was validly attested."

## 8. `settlement diagnose` — why didn't this intent settle? **[M]**

**Why.** The forensic counterpart to verification: an intent that should have
settled but didn't.

**Approach.** Correlate the intent against the destination: never filled vs
filled-late vs filled-wrong-recipient/amount. Where a continuous on-chain state
is involved, reuse the `solvency --since` bisection to pin when it broke.

**Acceptance.** Given an unsettled intent, output the specific failure mode with
the supporting on-chain evidence.

---

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Each item above
has a tracking issue.
