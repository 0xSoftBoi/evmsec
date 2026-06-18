import { Contract, formatUnits } from "ethers";
import { chain } from "../config.js";
import { ERC20_ABI, getProvider, requireAddress, to18 } from "../lib.js";
import { Route, loadRoutes, findRoute } from "../bridges.js";

interface SolvencyResult {
  id: string;
  bridge: string;
  asset: string;
  lockChain: string;
  mintChain: string;
  locked: string;
  minted: string;
  /** backing ratio in percent, or null when nothing is minted (no exposure). */
  ratioPct: number | null;
  /** signed locked - minted, normalized to 18dp and formatted. */
  delta: string;
  verdict: "BACKED" | "UNDERCOLLATERALIZED" | "NO_SUPPLY";
}

/**
 * `evmsec solvency <route-id | --all | ad-hoc flags>`
 *
 * Checks whether locked collateral on the source chain backs the wrapped
 * supply minted on the destination chain. Exits non-zero if any route is
 * undercollateralized — so it drops straight into CI / a monitoring cron.
 */
export async function solvency(args: string[]): Promise<void> {
  const opts = parse(args);

  let routes: Route[];
  if (opts.adHoc) {
    routes = [opts.adHoc];
  } else if (opts.all) {
    routes = loadRoutes();
  } else if (opts.id) {
    routes = [findRoute(opts.id)];
  } else {
    throw new Error(
      "usage: evmsec solvency <route-id> | --all | " +
        "--lock-chain <c> --escrow 0x.. --token 0x.. --mint-chain <c> --minted 0x.. [--min-ratio 100] [--json]",
    );
  }

  const results: SolvencyResult[] = [];
  for (const route of routes) {
    results.push(await checkRoute(route));
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    render(results, opts.minRatio);
  }

  const breached = results.some(
    (r) => r.verdict === "UNDERCOLLATERALIZED" || (r.ratioPct !== null && r.ratioPct < opts.minRatio),
  );
  if (breached) process.exitCode = 1;
}

async function checkRoute(route: Route): Promise<SolvencyResult> {
  const lockChain = chain(route.lock.chain);
  const mintChain = chain(route.mint.chain);
  const lockProvider = getProvider(lockChain);
  const mintProvider = getProvider(mintChain);

  const escrow = requireAddress(route.lock.escrow, "escrow");
  const lockToken = new Contract(requireAddress(route.lock.token, "lock token"), ERC20_ABI, lockProvider);
  const mintToken = new Contract(requireAddress(route.mint.token, "mint token"), ERC20_ABI, mintProvider);

  const [lockedRaw, lockDec, mintedRaw, mintDec] = await Promise.all([
    lockToken.balanceOf(escrow) as Promise<bigint>,
    lockToken.decimals().then(Number) as Promise<number>,
    mintToken.totalSupply() as Promise<bigint>,
    mintToken.decimals().then(Number) as Promise<number>,
  ]);

  const locked18 = to18(lockedRaw, lockDec);
  const minted18 = to18(mintedRaw, mintDec);

  let ratioPct: number | null;
  let verdict: SolvencyResult["verdict"];
  if (minted18 === 0n) {
    ratioPct = null;
    verdict = "NO_SUPPLY";
  } else {
    // basis points -> percent, keeps precision for huge supplies
    ratioPct = Number((locked18 * 1_000_000n) / minted18) / 10_000;
    verdict = locked18 >= minted18 ? "BACKED" : "UNDERCOLLATERALIZED";
  }

  const delta18 = locked18 - minted18;
  const deltaStr = `${delta18 >= 0n ? "+" : "-"}${formatUnits(delta18 < 0n ? -delta18 : delta18, 18)}`;

  return {
    id: route.id,
    bridge: route.bridge,
    asset: route.asset,
    lockChain: lockChain.name,
    mintChain: mintChain.name,
    locked: formatUnits(lockedRaw, lockDec),
    minted: formatUnits(mintedRaw, mintDec),
    ratioPct,
    delta: deltaStr,
    verdict,
  };
}

function render(results: SolvencyResult[], minRatio: number): void {
  for (const r of results) {
    const mark =
      r.verdict === "BACKED" && (r.ratioPct ?? 0) >= minRatio
        ? "✓"
        : r.verdict === "NO_SUPPLY"
          ? "·"
          : "✗";
    const ratio = r.ratioPct === null ? "n/a" : `${r.ratioPct.toFixed(2)}%`;

    console.log(`\n${mark} ${r.bridge} — ${r.asset}  [${r.id}]`);
    console.log("─".repeat(64));
    console.log(`  locked   ${r.locked}  (${r.lockChain})`);
    console.log(`  minted   ${r.minted}  (${r.mintChain})`);
    console.log(`  backing  ${ratio}    delta ${r.delta}`);
    console.log(`  verdict  ${r.verdict}${r.verdict === "UNDERCOLLATERALIZED" ? "  ⚠ bridge is printing unbacked supply" : ""}`);
  }
  console.log();
}

interface Opts {
  id?: string;
  all: boolean;
  json: boolean;
  minRatio: number;
  adHoc?: Route;
}

function parse(args: string[]): Opts {
  const opts: Opts = { all: false, json: false, minRatio: 100 };
  const adHoc: Partial<{ lockChain: string; escrow: string; token: string; mintChain: string; minted: string }> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--all": opts.all = true; break;
      case "--json": opts.json = true; break;
      case "--min-ratio": opts.minRatio = Number(args[++i]); break;
      case "--lock-chain": adHoc.lockChain = args[++i]; break;
      case "--escrow": adHoc.escrow = args[++i]; break;
      case "--token": adHoc.token = args[++i]; break;
      case "--mint-chain": adHoc.mintChain = args[++i]; break;
      case "--minted": adHoc.minted = args[++i]; break;
      default:
        if (!a.startsWith("-") && !opts.id) opts.id = a;
    }
  }

  if (adHoc.lockChain || adHoc.escrow || adHoc.token || adHoc.mintChain || adHoc.minted) {
    const missing = (["lockChain", "escrow", "token", "mintChain", "minted"] as const).filter((k) => !adHoc[k]);
    if (missing.length) throw new Error(`ad-hoc route missing: ${missing.map((m) => "--" + m.replace("Chain", "-chain")).join(", ")}`);
    opts.adHoc = {
      id: "ad-hoc",
      bridge: "ad-hoc route",
      asset: "asset",
      lock: { chain: adHoc.lockChain as Route["lock"]["chain"], escrow: adHoc.escrow!, token: adHoc.token! },
      mint: { chain: adHoc.mintChain as Route["mint"]["chain"], token: adHoc.minted! },
    };
  }

  return opts;
}
