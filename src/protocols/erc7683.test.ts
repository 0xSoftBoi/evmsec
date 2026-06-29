import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, zeroPadValue } from "ethers";
import { erc20Interface, erc7683Interface } from "../lib.js";
import { erc7683 } from "./erc7683.js";
import { getProtocol, DEFAULT_PROTOCOL } from "./index.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ALICE = "0x00000000000000000000000000000000000000A1";
const b32 = (addr: string): string => zeroPadValue(addr, 32);

/** Build a real `Open` event log via the ABI, so the decoder is tested against canonical encoding. */
function openLog(
  over: { recipient?: string; token?: string; amount?: bigint; chainId?: number; fillDeadline?: number } = {},
) {
  const output = {
    token: b32(over.token ?? USDC),
    amount: over.amount ?? 1_000_000n,
    recipient: b32(over.recipient ?? ALICE),
    chainId: BigInt(over.chainId ?? 8453),
  };
  const resolvedOrder = {
    user: ALICE,
    originChainId: 1n,
    openDeadline: 0,
    fillDeadline: over.fillDeadline ?? 1_900_000_000,
    orderId: b32("0x0000000000000000000000000000000000000001"),
    maxSpent: [output],
    minReceived: [],
    fillInstructions: [],
  };
  const orderId = b32("0x0000000000000000000000000000000000000009");
  const { data, topics } = erc7683Interface.encodeEventLog("Open", [orderId, resolvedOrder]);
  return { address: "0x000000000000000000000000000000000000dEaD", topics, data };
}

test("getProtocol: default resolves, unknown throws", () => {
  assert.equal(getProtocol(DEFAULT_PROTOCOL).key, "erc7683");
  assert.throws(() => getProtocol("nope"), /unknown protocol/);
});

test("erc7683.parseIntent: decodes Open into a normalized order", () => {
  const order = erc7683.parseIntent([openLog()], { srcChainId: 1 });
  assert.ok(order);
  assert.equal(order!.protocol, "erc7683");
  assert.equal(order!.fillDeadline, 1_900_000_000);
  assert.equal(order!.outputs.length, 1);
  const out = order!.outputs[0];
  assert.equal(out.token, getAddress(USDC));
  assert.equal(out.recipient, getAddress(ALICE));
  assert.equal(out.amount, 1_000_000n);
  assert.equal(out.chainId, 8453);
  assert.equal(out.native, false);
});

test("erc7683.parseIntent: native (zero-address) output is flagged", () => {
  const order = erc7683.parseIntent([openLog({ token: "0x0000000000000000000000000000000000000000" })], {
    srcChainId: 1,
  });
  assert.equal(order!.outputs[0].native, true);
});

test("erc7683.parseIntent: no Open event → null", () => {
  const transfer = erc20Interface.encodeEventLog("Transfer", [ALICE, USDC, 1n]);
  const log = { address: USDC, topics: transfer.topics, data: transfer.data };
  assert.equal(erc7683.parseIntent([log], { srcChainId: 1 }), null);
});

test("erc7683.parseFill: decodes ERC-20 Transfers to the recipient", () => {
  const t = erc20Interface.encodeEventLog("Transfer", [USDC, ALICE, 1_000_000n]);
  const transfers = erc7683.parseFill([{ address: USDC, topics: t.topics, data: t.data }]);
  assert.equal(transfers.length, 1);
  assert.equal(getAddress(transfers[0].to), getAddress(ALICE));
  assert.equal(transfers[0].value, 1_000_000n);
});
