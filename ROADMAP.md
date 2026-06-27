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

Follow-ups since shipped: ✅ `MINTER_ROLE` holders are now enumerated
(AccessControlEnumerable, or `RoleGranted` history as a fallback) and classified
EOA vs contract; ✅ a supply cap (`cap()` / `maxSupply()`) is detected and read.
Still open: resolve a `masterMinter`-style indirection where minting isn't gated
by `owner()`.

A sibling check, **`pause-guardian <token>`**, also shipped: who can freeze
transfers, is the token paused now, and is the pause key a single EOA.

## 2. `solvency --watch` — alert the moment backing breaks ✅ **shipped**

A lightweight self-hosted alternative to managed monitoring (Hexagate, Forta, OZ
Defender). `evmsec solvency --all --watch --interval 60 [--webhook URL]` polls on
an interval and fires **once per breach transition** (de-duped via
`computeTransitions` in `solvency-core.ts`), recovering quietly; clean shutdown
on SIGINT/SIGTERM. Still open: subscribe to escrow `Transfer` / supply-change
events instead of polling, and a `--delta` degrade threshold.

## 3. Multi-asset bridges — sum escrows across many tokens ✅ **shipped**

A route's `lock` now accepts an **array of legs** (`{chain, escrow, token}`),
summed — each normalized to 18 dp — against the minted supply (`sumLocked18` in
`solvency-core.ts`). Backward-compatible: single-leg routes are unchanged. Legs
must denominate the same unit as the minted token. Still open: differently-priced
baskets (needs a price oracle) and multiple wrapped tokens on the mint side.

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
