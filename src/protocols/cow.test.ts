import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface, getAddress, toUtf8Bytes, hexlify } from "ethers";
import { cow } from "./cow.js";

const SELL = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC
const BUY = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // DAI
const ALICE = "0x00000000000000000000000000000000000000A1";
const BOB = "0x00000000000000000000000000000000000000B0";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const iface = new Interface([
  "event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)",
]);

function tradeLog(owner: string, buyToken: string, buyAmount: bigint) {
  const { data, topics } = iface.encodeEventLog("Trade", [
    owner,
    SELL,
    buyToken,
    1_000_000n,
    buyAmount,
    0n,
    hexlify(toUtf8Bytes("uid")),
  ]);
  return { address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41", topics, data };
}

test("cow.parseIntent: one Trade → one output (owner receives buyToken)", () => {
  const order = cow.parseIntent([tradeLog(ALICE, BUY, 500_000n)], { srcChainId: 1 });
  assert.ok(order);
  assert.equal(order!.protocol, "cow");
  assert.equal(order!.fillDeadline, 0); // no deadline in the event
  assert.equal(order!.outputs.length, 1);
  assert.equal(order!.outputs[0].token, getAddress(BUY));
  assert.equal(order!.outputs[0].recipient, getAddress(ALICE));
  assert.equal(order!.outputs[0].amount, 500_000n);
  assert.equal(order!.outputs[0].chainId, 1); // from ctx (same-chain)
  assert.equal(order!.outputs[0].native, false);
});

test("cow.parseIntent: a batch of Trades becomes multiple outputs", () => {
  const order = cow.parseIntent([tradeLog(ALICE, BUY, 1n), tradeLog(BOB, BUY, 2n)], { srcChainId: 1 });
  assert.equal(order!.outputs.length, 2);
  assert.equal(order!.outputs[1].recipient, getAddress(BOB));
});

test("cow.parseIntent: native-sentinel buy token is flagged native", () => {
  const order = cow.parseIntent([tradeLog(ALICE, NATIVE, 1n)], { srcChainId: 1 });
  assert.equal(order!.outputs[0].native, true);
});

test("cow.parseIntent: no Trade event → null", () => {
  const log = { address: "0x0", topics: ["0x" + "22".repeat(32)], data: "0x" };
  assert.equal(cow.parseIntent([log], { srcChainId: 1 }), null);
});
