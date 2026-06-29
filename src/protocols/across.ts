import { Interface, getAddress } from "ethers";
import { bytes32ToAddress } from "../lib.js";
import { ExpectedOutput, LogLike, decodeErc20Transfers, isNativeToken } from "../settlement-core.js";
import { NormalizedOrder, Protocol } from "./types.js";

/**
 * Across — the origin SpokePool emits a deposit event naming the `outputToken`,
 * `outputAmount`, `recipient`, `destinationChainId`, and `fillDeadline` the
 * relayer must honor on the destination. The relayer's fill is an ERC-20
 * transfer of that token to the recipient, so the default ERC-20 `parseFill`
 * verifies it.
 *
 * Two event shapes are live on mainnet: the current `FundsDeposited` (bytes32
 * fields, for non-EVM support) and the legacy `V3FundsDeposited` (address
 * fields). We decode whichever is present. ABIs are from the official
 * across-protocol/contracts `V3SpokePoolInterface` — validate against a real
 * deposit before trusting a number.
 */
const ABI = [
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
  "event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)",
];
const iface = new Interface(ABI);
const MODERN_TOPIC = iface.getEvent("FundsDeposited")!.topicHash;
const LEGACY_TOPIC = iface.getEvent("V3FundsDeposited")!.topicHash;

export const across: Protocol = {
  key: "across",
  label: "Across",

  parseIntent(logs: readonly LogLike[]): NormalizedOrder | null {
    for (const log of logs) {
      const topic = log.topics[0];
      if (topic !== MODERN_TOPIC && topic !== LEGACY_TOPIC) continue;
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const a = parsed.args;

      // Modern fields are bytes32 (take the low 20 bytes); legacy are addresses.
      const asAddr = topic === MODERN_TOPIC ? (w: string) => bytes32ToAddress(w) : (w: string) => getAddress(w);
      const outputToken = asAddr(a.outputToken as string);
      const recipient = asAddr(a.recipient as string);
      const depositor = asAddr(a.depositor as string);

      const output: ExpectedOutput = {
        token: outputToken,
        amount: a.outputAmount as bigint,
        recipient,
        chainId: Number(a.destinationChainId),
        native: isNativeToken(outputToken),
      };
      return {
        protocol: "across",
        orderId: String(a.depositId),
        user: depositor,
        fillDeadline: Number(a.fillDeadline),
        outputs: [output],
      };
    }
    return null;
  },

  parseFill: decodeErc20Transfers,
};
