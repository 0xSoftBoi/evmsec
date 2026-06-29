import { bytes32ToAddress, erc7683Interface } from "../lib.js";
import { ExpectedOutput, LogLike, decodeErc20Transfers, isNativeToken } from "../settlement-core.js";
import { NormalizedOrder, Protocol } from "./types.js";

const OPEN_TOPIC = erc7683Interface.getEvent("Open")!.topicHash;

/**
 * ERC-7683 — the standard cross-chain intent format. The origin settler emits
 * `Open` with the full ResolvedCrossChainOrder; `maxSpent` is what the filler
 * must deliver to the user on the destination chain. Tokens/recipients are
 * bytes32 (for non-EVM support); we take the low 20 bytes.
 */
export const erc7683: Protocol = {
  key: "erc7683",
  label: "ERC-7683",

  parseIntent(logs: readonly LogLike[], _ctx): NormalizedOrder | null {
    for (const log of logs) {
      if (log.topics[0] !== OPEN_TOPIC) continue;
      const parsed = erc7683Interface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const ro = parsed.args.resolvedOrder;
      const outputs: ExpectedOutput[] = ro.maxSpent.map(
        (x: { token: string; amount: bigint; recipient: string; chainId: bigint }) => {
          const token = bytes32ToAddress(x.token);
          return {
            token,
            amount: x.amount,
            recipient: bytes32ToAddress(x.recipient),
            chainId: Number(x.chainId),
            native: isNativeToken(token),
          };
        },
      );
      return {
        protocol: "erc7683",
        orderId: parsed.args.orderId as string,
        user: ro.user as string,
        fillDeadline: Number(ro.fillDeadline),
        outputs,
      };
    }
    return null;
  },

  parseFill: decodeErc20Transfers,
};
