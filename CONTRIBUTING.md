# Contributing to evmsec

Two kinds of contributions are especially welcome: **verified bridge routes** for
the registry, and **new security checks**.

## Dev setup

```bash
npm install
npm run typecheck
npm test
npm run evmsec -- help
```

Tests use Node's built-in runner via `tsx --test`. Pure logic (backing math,
the forensic bisection, slot parsing) is unit-tested in `src/*.test.ts` and runs
with no network. Add tests for any logic you add.

## Adding a bridge route to the registry

`bridges.json` is the community registry the `solvency` command reads. **A
security tool fed the wrong escrow lies confidently** — so every route must be
verifiable from a primary source.

A route asserts the lock-and-mint invariant:

```
balanceOf(lock.token @ lock.escrow)  >=  totalSupply(mint.token)
```

Add an entry under `"routes"`:

```json
{
  "id": "stable-kebab-id",
  "bridge": "Human Bridge Name",
  "asset": "USDC",
  "lock": { "chain": "ethereum", "escrow": "0x…", "token": "0x…" },
  "mint": { "chain": "polygon",  "token": "0x…" },
  "notes": "Primary source: <link to the bridge's own deployment docs / verified contract>"
}
```

Requirements for a route PR:

1. **Cite a primary source** in `notes` for the escrow and both token addresses —
   the bridge's own docs or an explorer-verified contract. Not a third-party list.
2. **Sanity-check it runs**: `npm run evmsec -- solvency <your-id>` should return a
   plausible backing ratio (a healthy bridge reads at or just above 100%).
3. `chain` values must be ones in `src/config.ts` (add the chain there if missing).

Routes whose addresses can't be traced to a primary source will not be merged.

## Adding a security check

New commands live in `src/commands/` and register in `src/index.ts`. Keep the
pure logic in `src/lib.ts` (or a sibling) so it can be unit-tested without RPC.
Open an issue first if it's a large addition.

## Conventions

- ethers v6, ESM, strict TypeScript — `npm run typecheck` must pass.
- Prefer `bigint` for on-chain amounts; only convert to `Number` for display.
- No silent failures in a security tool: if state can't be read, say so.
