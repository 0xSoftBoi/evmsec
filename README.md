# evmsec

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
your file). ⚠️ The bundled entries are *illustrative* — verify every address
against the bridge's own source before trusting a number. A security tool fed
the wrong escrow lies confidently.

### `upgradeability` — who can rug this?

```bash
npm run evmsec -- upgradeability 0xToken --chain base
```

Reads EIP-1967 slots: is it an upgradeable proxy, what's the implementation, and
is the upgrade admin a single EOA (one key from a rug) or a contract
(multisig/timelock)?

## Supported chains

`ethereum · base · arbitrum · optimism · polygon · sepolia · base-sepolia`
— override any RPC via env (`ETHEREUM_RPC_URL`, `BASE_RPC_URL`, …).

## Layout

```
src/
  config.ts                chains, RPCs
  lib.ts                   provider cache, ERC-20 ABI, EIP-1967 slots, math
  bridges.ts               route registry loader
  commands/
    solvency.ts            flagship: lock-vs-mint backing check
    upgradeability.ts      EIP-1967 proxy / admin risk
  index.ts                 CLI dispatcher
bridges.json               route registry (verify before trusting)
```

## Roadmap

- `mint-authority <token>` — who can mint; is ownership renounced?
- `solvency --watch` — stream lock/mint events, alert the moment backing breaks
- multi-asset bridges (sum escrows across many tokens)
- a community-verified `bridges.json` registry

## Contributing

Verified bridge routes and new checks welcome. Every registry address must cite
a primary source (the bridge's own deployment docs/contract).

## License

MIT
