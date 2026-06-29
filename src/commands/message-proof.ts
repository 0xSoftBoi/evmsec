import { ChainConfig, chain } from "../config.js";
import { addrLink, getProvider, requireAddress } from "../lib.js";
import { MessageProofVerdict } from "../message-proof-core.js";
import { getLayer } from "../message-layers/index.js";

/**
 * `evmsec message-proof --layer <hyperlane|wormhole> --chain <dest> [--id 0x..] [--vaa 0x..]`
 *
 * Settlement confirms a token *delivery*; this confirms the stronger property —
 * that a *validly attested message* crossed the messaging layer — by checking
 * the attestation on the destination chain:
 *   - Hyperlane: `Mailbox.delivered(messageId)` (ISM-verified + executed)
 *   - Wormhole:  `Core.parseAndVerifyVM(vaa)`   (guardian signatures valid)
 *
 * Exit code is non-zero unless the message is confirmed verified — so an
 * unattested or unrelayed message fails a CI gate.
 */
export async function messageProof(args: string[]): Promise<void> {
  const o = parse(args);
  if (!o.layer) {
    throw new Error(
      "usage: evmsec message-proof --layer <hyperlane|wormhole> --chain <dest-chain> " +
        "[--id <messageId>] [--vaa <0x..>] [--contract <addr>] [--json]\n" +
        "  hyperlane: --id <bytes32 message id>   ·   wormhole: --vaa <0x encoded VAA>",
    );
  }

  const layer = getLayer(o.layer);
  const c = chain(o.chainKey);
  const contract = o.contract ? requireAddress(o.contract, "contract") : layer.contractFor(c);
  if (!contract) {
    throw new Error(
      `no bundled ${layer.label} contract for ${c.name} — pass --contract <addr> (the ${layer.label} verifying contract on ${c.name})`,
    );
  }

  const provider = getProvider(c);
  const verdict = await layer.verify(provider, contract, { messageId: o.id, vaa: o.vaa });

  if (o.json) {
    console.log(JSON.stringify({ chain: c.key, contract, ...verdict }, null, 2));
  } else {
    print(c, contract, layer.label, verdict);
  }

  if (verdict.status !== "verified") process.exitCode = 1;
}

const MARK: Record<string, string> = {
  verified: "✓ VERIFIED",
  unverified: "✗ UNVERIFIED",
  indeterminate: "? INDETERMINATE",
};

function print(c: ChainConfig, contract: string, label: string, v: MessageProofVerdict): void {
  console.log(`\nMessage-proof — ${label} on ${c.name}`);
  console.log("─".repeat(68));
  console.log(`  verifier        ${contract}`);
  console.log(`                  ${addrLink(c, contract)}`);
  console.log(`  status          ${MARK[v.status] ?? v.status}`);
  for (const d of v.detail) console.log(`  · ${d}`);
  console.log(
    `\n  Confirms the messaging-layer attestation on the destination — not the\n  intent/token semantics. Cross-check the payload against what you expect.\n`,
  );
}

function parse(args: string[]): {
  layer?: string;
  chainKey: string;
  id?: string;
  vaa?: string;
  contract?: string;
  json: boolean;
} {
  const o: { layer?: string; chainKey: string; id?: string; vaa?: string; contract?: string; json: boolean } = {
    chainKey: "ethereum",
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--layer":
        o.layer = args[++i];
        break;
      case "--chain":
      case "-c":
        o.chainKey = args[++i];
        break;
      case "--id":
        o.id = args[++i];
        break;
      case "--vaa":
        o.vaa = args[++i];
        break;
      case "--contract":
        o.contract = args[++i];
        break;
      case "--json":
        o.json = true;
        break;
    }
  }
  return o;
}
