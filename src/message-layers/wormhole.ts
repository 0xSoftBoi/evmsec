import { Contract, JsonRpcProvider } from "ethers";
import { ChainConfig, ChainKey } from "../config.js";
import { withRetry } from "../lib.js";
import { VaaHeader, classifyWormhole, parseVaaHeader } from "../message-proof-core.js";
import { MessageLayer, VerifyArgs } from "./types.js";

// Wormhole Core Bridge addresses — each verified live against
// getCurrentGuardianSetIndex before bundling. Override with --contract.
const CORE: Partial<Record<ChainKey, string>> = {
  ethereum: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B",
  base: "0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6",
  arbitrum: "0xa5f208e072434bC67592E4C49C1B991BA79BCA46",
  optimism: "0xEe91C335eab126dF5fDB3797EA9d6aD93aeC9722",
  polygon: "0x7A4B5a56256163F07b2C80A7cA55aBE66c4ec4d7",
};

// parseAndVerifyVM returns (VM, valid, reason). We only consume `valid`/`reason`;
// the VM tuple is declared in full so ethers can decode the return.
const ABI = [
  "function parseAndVerifyVM(bytes encodedVM) view returns (" +
    "tuple(uint8 version, uint32 timestamp, uint32 nonce, uint16 emitterChainId, bytes32 emitterAddress, " +
    "uint64 sequence, uint8 consistencyLevel, bytes payload, uint32 guardianSetIndex, " +
    "tuple(bytes32 r, bytes32 s, uint8 v, uint8 guardianIndex)[] signatures, bytes32 hash) vm, " +
    "bool valid, string reason)",
];

/**
 * Wormhole — `Core.parseAndVerifyVM(vaa)` checks the guardian signatures against
 * the current guardian set on the destination chain. `valid = true` is the
 * cryptographic attestation that the message is genuine; that, and only that,
 * marks it verified. The VAA bytes come from the guardian network (e.g.
 * wormholescan), supplied via `--vaa`.
 */
export const wormhole: MessageLayer = {
  key: "wormhole",
  label: "Wormhole",
  contractFor: (chain: ChainConfig) => CORE[chain.key] ?? null,

  async verify(provider: JsonRpcProvider, contract: string, args: VerifyArgs) {
    if (!args.vaa) throw new Error("wormhole needs --vaa <0x-encoded VAA> (from the guardian network / wormholescan)");
    const core = new Contract(contract, ABI, provider);
    const [, valid, reason] = (await withRetry(() => core.parseAndVerifyVM(args.vaa), {
      label: "parseAndVerifyVM",
    })) as [unknown, boolean, string];

    let header: VaaHeader | undefined;
    try {
      header = parseVaaHeader(args.vaa);
    } catch {
      header = undefined; // header parse is best-effort; the contract result is authoritative
    }
    return classifyWormhole(Boolean(valid), String(reason), header);
  },
};
