#!/usr/bin/env node
import { solvency } from "./commands/solvency.js";
import { upgradeability } from "./commands/upgradeability.js";
import { settlement } from "./commands/settlement.js";
import { pqReadiness } from "./commands/pq-readiness.js";
import { mintAuthority } from "./commands/mint-authority.js";
import { pauseGuardian } from "./commands/pause-guardian.js";
import { messageProof } from "./commands/message-proof.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  solvency,
  upgradeability,
  settlement,
  "pq-readiness": pqReadiness,
  "mint-authority": mintAuthority,
  "pause-guardian": pauseGuardian,
  "message-proof": messageProof,
};

const HELP = `evmsec — a security CLI for EVM chains

usage: evmsec <command> [args]

commands:
  solvency <route-id|--all>     is a lock-and-mint bridge fully backed?
                                  (locked collateral ≥ wrapped supply minted)
  upgradeability <address>      EIP-1967 proxy check: upgradeable? who controls it?
  mint-authority <token>        can the wrapped supply be inflated, and by whom?
                                  (mint entrypoints + owner/MINTER_ROLE + cap)
  pause-guardian <token>        can transfers be frozen, are they now, and who
                                  holds the pause key? (owner/PAUSER_ROLE)
  settlement                    did a cross-chain intent actually get filled?
                                  (--protocol erc7683 --intent-tx --fill-tx)
  message-proof <--layer>       was a cross-chain message validly attested?
                                  (Wormhole VAA / Hyperlane delivered)
  pq-readiness <address>        is this verifier post-quantum ready, or
                                  Shor-breakable? (ECDSA/BLS vs ML-DSA/lattice)

solvency flags:
  --all                         check every route in the registry
  --since <block|date>          forensic: binary-search history for the block
                                  where backing first broke (needs archive RPC)
  --watch                       poll continuously; alert once per breach transition
  --interval <sec>              --watch poll interval (default 60)
  --webhook <url>               --watch: POST a JSON alert on each transition
  --delta <pp>                  --watch: also alert on a sudden backing drop (points)
  --min-ratio <pct>             alert threshold (default 100)
  --json                        machine-readable output (for CI / monitoring)
  ad-hoc:  --lock-chain <c> --escrow 0x.. --token 0x.. --mint-chain <c> --minted 0x..
  (a route's lock may be an array of legs — multi-asset escrows are summed)

global:
  --chain, -c <key>             ethereum, base, arbitrum, optimism, polygon, sepolia, base-sepolia

exit code is non-zero when a bridge is undercollateralized — drop it in a cron.

examples:
  evmsec solvency --all
  evmsec solvency my-route --since 2024-01-01      # when did backing break?
  evmsec solvency --lock-chain ethereum --escrow 0xEsc --token 0xUSDC \\
                  --mint-chain polygon --minted 0xWrapped --json
  evmsec upgradeability 0xToken --chain base
  evmsec mint-authority 0xWrappedToken --chain polygon --json
  evmsec pause-guardian 0xWrappedToken --chain polygon
  evmsec message-proof --layer hyperlane --chain base --id 0xMessageId
  evmsec message-proof --layer wormhole --chain ethereum --vaa 0x01000000... --json
  evmsec settlement --source-chain ethereum --intent-tx 0xOpen \\
                    --fill-tx 0xFill
  evmsec pq-readiness 0xVerifier --chain ethereum --json
`;

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  await handler(args);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
