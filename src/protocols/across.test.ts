import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface, getAddress, zeroPadValue } from "ethers";
import { across } from "./across.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OUT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged token on dest
const ALICE = "0x00000000000000000000000000000000000000A1";
const b32 = (a: string): string => zeroPadValue(a, 32);

// Build event logs with the same ABI the decoder declares (round-trip).
const ABI = [
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
  "event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)",
];
const iface = new Interface(ABI);
const ADDR = "0x000000000000000000000000000000000000aCC0";

function modernLog() {
  const { data, topics } = iface.encodeEventLog("FundsDeposited", [
    b32(USDC),
    b32(OUT),
    1_000_000n,
    990_000n,
    137n,
    42n,
    0,
    1_900_000_000,
    0,
    b32(ALICE),
    b32(ALICE),
    b32(ALICE),
    "0x",
  ]);
  return { address: ADDR, topics, data };
}
function legacyLog() {
  const { data, topics } = iface.encodeEventLog("V3FundsDeposited", [
    USDC,
    OUT,
    1_000_000n,
    990_000n,
    137n,
    42,
    0,
    1_900_000_000,
    0,
    ALICE,
    ALICE,
    ALICE,
    "0x",
  ]);
  return { address: ADDR, topics, data };
}

test("across.parseIntent: decodes modern FundsDeposited (bytes32 fields)", () => {
  const order = across.parseIntent([modernLog()], { srcChainId: 1 });
  assert.ok(order);
  assert.equal(order!.protocol, "across");
  assert.equal(order!.fillDeadline, 1_900_000_000);
  assert.equal(order!.outputs.length, 1);
  const out = order!.outputs[0];
  assert.equal(out.token, getAddress(OUT));
  assert.equal(out.recipient, getAddress(ALICE));
  assert.equal(out.amount, 990_000n);
  assert.equal(out.chainId, 137);
});

test("across.parseIntent: decodes legacy V3FundsDeposited (address fields)", () => {
  const order = across.parseIntent([legacyLog()], { srcChainId: 1 });
  assert.ok(order);
  assert.equal(order!.outputs[0].token, getAddress(OUT));
  assert.equal(order!.outputs[0].amount, 990_000n);
  assert.equal(order!.outputs[0].chainId, 137);
  assert.equal(order!.orderId, "42");
});

test("across.parseIntent: no deposit event → null", () => {
  const log = { address: ADDR, topics: ["0x" + "11".repeat(32)], data: "0x" };
  assert.equal(across.parseIntent([log], { srcChainId: 1 }), null);
});
