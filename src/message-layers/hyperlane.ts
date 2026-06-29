import { Contract, JsonRpcProvider } from "ethers";
import { ChainConfig, ChainKey } from "../config.js";
import { withRetry } from "../lib.js";
import { classifyHyperlane } from "../message-proof-core.js";
import { MessageLayer, VerifyArgs } from "./types.js";

// Hyperlane v3 Mailbox addresses — each verified live against the chain's
// localDomain (= chainId) before bundling. Override with --contract for others.
const MAILBOX: Partial<Record<ChainKey, string>> = {
  ethereum: "0xc005dc82818d67AF737725bD4bf75435d065D239",
  base: "0xeA87ae93Fa0019a82A727bfd3eBd1cFCa8f64f1D",
  arbitrum: "0x979Ca5202784112f4738403dBec5D0F3B9daabB9",
  optimism: "0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D",
  polygon: "0x5d934f4e2f797775e53561bB72aca21ba36B96BB",
};

const ABI = ["function delivered(bytes32 messageId) view returns (bool)"];

/**
 * Hyperlane — a message is verified on the destination once `Mailbox.process()`
 * has run it through the recipient's ISM and executed it. `delivered(messageId)`
 * reports exactly that, as a single view call.
 */
export const hyperlane: MessageLayer = {
  key: "hyperlane",
  label: "Hyperlane",
  contractFor: (chain: ChainConfig) => MAILBOX[chain.key] ?? null,

  async verify(provider: JsonRpcProvider, contract: string, args: VerifyArgs) {
    if (!args.messageId) throw new Error("hyperlane needs --id <messageId> (the bytes32 Hyperlane message id)");
    const mailbox = new Contract(contract, ABI, provider);
    const delivered = await withRetry(() => mailbox.delivered(args.messageId), { label: "delivered" });
    return classifyHyperlane(Boolean(delivered));
  },
};
