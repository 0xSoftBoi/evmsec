import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, JsonRpcProvider, Network, id } from "ethers";
import { captureAuthoritySnapshot, readSafeComposition } from "./checks/onchain.js";

/**
 * Deterministic tests for the Safe composition reader and the snapshot
 * capture, using a fake provider — no network. The reader's view calls
 * (getThreshold / getOwners / getModulesPaginated / getMinDelay) are answered
 * from scripted encodings, so the pagination, checksumming, and kind
 * detection are all exercised for real.
 */

const SENTINEL = "0x0000000000000000000000000000000000000001";
const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MODULE_1 = "0x1111111111111111111111111111111111111111";
const MODULE_2 = "0x2222222222222222222222222222222222222222";
const SAFE = "0xcccccccccccccccccccccccccccccccccccccccc";
const TIMELOCK = "0xdddddddddddddddddddddddddddddddddddddddd";
const EOA = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DELEGATED = "0xffffffffffffffffffffffffffffffffffffffff";
const PLAIN = "0x9999999999999999999999999999999999999999";
const DRAINER = "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b";

const coder = AbiCoder.defaultAbiCoder();
const sel = (sig: string): string => id(sig).slice(0, 10);

class FakeProvider extends JsonRpcProvider {
  constructor(private codes: Map<string, string>) {
    super("http://fake.invalid", 1, { staticNetwork: Network.from(1), batchMaxCount: 1 });
  }
  override async getCode(address: string): Promise<string> {
    return this.codes.get(address.toLowerCase()) ?? "0x";
  }
  override async call(tx: any): Promise<string> {
    const data = String(tx.data ?? "");
    if (data.startsWith(sel("getThreshold()"))) return coder.encode(["uint256"], [2]);
    if (data.startsWith(sel("getOwners()"))) return coder.encode(["address[]"], [[OWNER_A, OWNER_B]]);
    if (data.startsWith(sel("getModulesPaginated(address,uint256)"))) {
      // two pages: SENTINEL -> MODULE_1, next=MODULE_2 -> MODULE_2, next=SENTINEL
      const start = "0x" + data.slice(10 + 24, 10 + 64);
      if (start.toLowerCase() === SENTINEL.toLowerCase())
        return coder.encode(["address[]", "address"], [[MODULE_1], MODULE_2]);
      return coder.encode(["address[]", "address"], [[MODULE_2], SENTINEL]);
    }
    if (data.startsWith(sel("getMinDelay()"))) return coder.encode(["uint256"], [172800]);
    throw new Error(`unexpected call ${data.slice(0, 10)}`);
  }
}

const codes = (entries: Array<[string, string]>): Map<string, string> =>
  new Map(entries.map(([a, c]) => [a.toLowerCase(), c]));

test("readSafeComposition: threshold, owners, and paginated modules", async () => {
  const p = new FakeProvider(codes([[SAFE, "0x6000"]]));
  const comp = await readSafeComposition(p as never, SAFE);
  assert.ok(comp);
  assert.equal(comp.threshold, 2);
  // owners checksummed
  assert.deepEqual(comp.owners, [
    "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
    "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB",
  ]);
  assert.deepEqual(comp.modules, [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ]);
});

test("readSafeComposition: non-Safe contract returns null", async () => {
  class Nope extends FakeProvider {
    override async call(): Promise<string> {
      throw new Error("revert");
    }
  }
  const comp = await readSafeComposition(new Nope(codes([])) as never, PLAIN);
  assert.equal(comp, null);
});

test("captureAuthoritySnapshot: safe kind with full composition", async () => {
  const p = new FakeProvider(codes([[SAFE, "0x6000"]]));
  const s = await captureAuthoritySnapshot(p as never, "ethereum", SAFE, "test safe");
  assert.equal(s.kind, "safe");
  assert.equal(s.threshold, 2);
  assert.equal(s.owners!.length, 2);
  assert.equal(s.modules!.length, 2);
  assert.ok(s.codehash.startsWith("0x"));
});

test("captureAuthoritySnapshot: plain EOA", async () => {
  const p = new FakeProvider(codes([]));
  const s = await captureAuthoritySnapshot(p as never, "ethereum", EOA, "test eoa");
  assert.equal(s.kind, "eoa");
  assert.equal(s.delegation, null);
});

test("captureAuthoritySnapshot: 7702-delegated EOA records the delegate", async () => {
  const p = new FakeProvider(codes([[DELEGATED, "0xef0100" + DRAINER.slice(2)]]));
  const s = await captureAuthoritySnapshot(p as never, "ethereum", DELEGATED, "drained?");
  assert.equal(s.kind, "eoa");
  assert.equal(s.delegation!.toLowerCase(), DRAINER.toLowerCase());
});

test("captureAuthoritySnapshot: timelock reads the delay", async () => {
  // timelock probe: getThreshold/getOwners revert for this address
  class Tl extends FakeProvider {
    override async call(tx: any): Promise<string> {
      const data = String(tx.data ?? "");
      if (data.startsWith(sel("getThreshold()")) || data.startsWith(sel("getOwners()"))) throw new Error("revert");
      return super.call(tx);
    }
  }
  const s = await captureAuthoritySnapshot(new Tl(codes([[TIMELOCK, "0x6000"]])) as never, "ethereum", TIMELOCK, "tl");
  assert.equal(s.kind, "timelock");
  assert.equal(s.minDelaySec, 172800);
});

test("captureAuthoritySnapshot: unknown when code is unreadable", async () => {
  class Broken extends FakeProvider {
    override async getCode(): Promise<string> {
      throw new Error("rpc down");
    }
  }
  const s = await captureAuthoritySnapshot(new Broken(codes([])) as never, "ethereum", PLAIN, "broken");
  assert.equal(s.kind, "unknown");
  assert.equal(s.codehash, "unreadable");
});
