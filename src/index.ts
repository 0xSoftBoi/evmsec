#!/usr/bin/env tsx
import { solvency } from "./commands/solvency.js";
import { upgradeability } from "./commands/upgradeability.js";
import { settlement } from "./commands/settlement.js";

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  solvency,
  upgradeability,
  settlement,
};

const HELP = `evmsec — a security CLI for EVM chains

usage: evmsec <command> [args]

commands:
  solvency <route-id|--all>     is a lock-and-mint bridge fully backed?
                                  (locked collateral ≥ wrapped supply minted)
  upgradeability <address>      EIP-1967 proxy check: upgradeable? who controls it?
  settlement                    did an ERC-7683 cross-chain intent actually get
                                  filled? (--source-chain --intent-tx --fill-tx)

solvency flags:
  --all                         check every route in the registry
  --since <block|date>          forensic: binary-search history for the block
                                  where backing first broke (needs archive RPC)
  --min-ratio <pct>             alert threshold (default 100)
  --json                        machine-readable output (for CI / monitoring)
  ad-hoc:  --lock-chain <c> --escrow 0x.. --token 0x.. --mint-chain <c> --minted 0x..

global:
  --chain, -c <key>             ethereum, base, arbitrum, optimism, polygon, sepolia, base-sepolia

exit code is non-zero when a bridge is undercollateralized — drop it in a cron.

examples:
  evmsec solvency --all
  evmsec solvency my-route --since 2024-01-01      # when did backing break?
  evmsec solvency --lock-chain ethereum --escrow 0xEsc --token 0xUSDC \\
                  --mint-chain polygon --minted 0xWrapped --json
  evmsec upgradeability 0xToken --chain base
  evmsec settlement --source-chain ethereum --intent-tx 0xOpen \\
                    --fill-tx 0xFill
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
