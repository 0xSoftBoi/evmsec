import { JsonRpcProvider } from "ethers";
import { ChainConfig } from "../config.js";
import { MessageProofVerdict } from "../message-proof-core.js";

/** The identifiers a layer needs to look up a specific message. */
export interface VerifyArgs {
  /** Hyperlane message id (bytes32). */
  messageId?: string;
  /** Wormhole encoded VAA (0x-hex). */
  vaa?: string;
}

/**
 * A messaging layer whose attestation can be confirmed on the destination chain
 * by an `eth_call` (no logs needed). `contractFor` returns the verifying
 * contract's address for a chain (or null when not bundled — the command then
 * requires `--contract`).
 */
export interface MessageLayer {
  key: string;
  label: string;
  contractFor(chain: ChainConfig): string | null;
  verify(provider: JsonRpcProvider, contract: string, args: VerifyArgs): Promise<MessageProofVerdict>;
}
