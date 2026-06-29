import { Interface, getAddress } from "ethers";
import { ExpectedOutput, LogLike, decodeErc20Transfers } from "../settlement-core.js";
import { IntentContext, NormalizedOrder, Protocol } from "./types.js";

/**
 * CoW Protocol — batch settlement is **same-chain**: the GPv2Settlement contract
 * emits one `Trade` per order (naming `owner`, `buyToken`, `buyAmount`) and the
 * ERC-20 transfers in the same tx are the delivery. So the intent tx and the
 * fill tx are the same transaction, and the source and destination chain are the
 * same. We decode every `Trade` in the batch into one expected output each.
 *
 * Honest limits: the `Trade` event carries `owner`, not the order's optional
 * `receiver` — so we verify delivery to the owner; a routed-to-receiver order
 * will read as a recipient mismatch (inspect manually). There is no fill
 * deadline in the event. ABI is the canonical GPv2Settlement `Trade`.
 */
const ABI = [
  "event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)",
];
const iface = new Interface(ABI);
const TRADE_TOPIC = iface.getEvent("Trade")!.topicHash;

// CoW (and EIP-7528) represent native ETH with this sentinel buy token.
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export const cow: Protocol = {
  key: "cow",
  label: "CoW Protocol",

  parseIntent(logs: readonly LogLike[], ctx: IntentContext): NormalizedOrder | null {
    const outputs: ExpectedOutput[] = [];
    let firstOwner = "";
    let firstUid = "";
    for (const log of logs) {
      if (log.topics[0] !== TRADE_TOPIC) continue;
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const a = parsed.args;
      const buyToken = getAddress(a.buyToken as string);
      const owner = getAddress(a.owner as string);
      if (!firstOwner) {
        firstOwner = owner;
        firstUid = String(a.orderUid);
      }
      outputs.push({
        token: buyToken,
        amount: a.buyAmount as bigint,
        recipient: owner,
        chainId: ctx.srcChainId, // same-chain settlement
        native: buyToken.toLowerCase() === NATIVE_SENTINEL,
      });
    }
    if (outputs.length === 0) return null;
    return { protocol: "cow", orderId: firstUid, user: firstOwner, fillDeadline: 0, outputs };
  },

  parseFill: decodeErc20Transfers,
};
