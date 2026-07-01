/**
 * Record / replay provider — the machinery behind the incident-fixture tests.
 *
 * Every on-chain read a check makes (getCode, getStorage, eth_call for a view
 * function, getLogs) flows through one choke point in ethers v6:
 * `JsonRpcApiProvider._perform(req)`. We record the real mainnet responses to
 * those requests once (see `scripts/capture-fixture.ts`), commit them, and replay
 * them offline in CI — so a test can run the *real* assessor against the *real*
 * historical state of an incident contract, with no network.
 *
 * This module is test-only and is excluded from the published build.
 */

import { JsonRpcProvider, Network } from "ethers";

export interface Recording {
  /** stable key for a `_perform` request. */
  key: string;
  /** the JSON-RPC-ish result, when the request succeeded. */
  result?: unknown;
  /** the error message, when the request reverted / failed. */
  error?: string;
}

/** Deterministic key for a `_perform` request (bigints → hex so JSON.stringify is total). */
export function performKey(req: unknown): string {
  return JSON.stringify(req, (_k, v) => (typeof v === "bigint" ? `0x${v.toString(16)}` : v));
}

/** Wraps a live provider and captures every `_perform` request/response pair. */
export class RecordingProvider extends JsonRpcProvider {
  readonly recordings: Recording[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _perform(req: any): Promise<any> {
    const key = performKey(req);
    try {
      const result = await super._perform(req);
      this.recordings.push({ key, result });
      return result;
    } catch (err) {
      this.recordings.push({ key, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}

/** Answers `_perform` from a committed recording — no network. Missing keys throw (a revert). */
export class ReplayProvider extends JsonRpcProvider {
  private readonly map: Map<string, Recording>;

  constructor(recordings: Recording[], chainId: number) {
    super("http://replay.invalid", chainId, { staticNetwork: Network.from(chainId), batchMaxCount: 1 });
    this.map = new Map(recordings.map((r) => [r.key, r]));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _perform(req: any): Promise<any> {
    const entry = this.map.get(performKey(req));
    if (!entry) throw new Error(`no recording for ${performKey(req)}`);
    if (entry.error !== undefined) throw new Error(entry.error);
    return entry.result;
  }
}
