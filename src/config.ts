import "dotenv/config";

export type ChainKey = "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "base-sepolia" | "sepolia";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: number;
  /** RPC URL — override via env (e.g. ETHEREUM_RPC_URL), else a public fallback. */
  rpcUrl: string;
  explorer: string;
  symbol: string;
}

function rpc(envKey: string, fallback: string): string {
  return process.env[envKey] ?? fallback;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    rpcUrl: rpc("ETHEREUM_RPC_URL", "https://ethereum-rpc.publicnode.com"),
    explorer: "https://etherscan.io",
    symbol: "ETH",
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpcUrl: rpc("BASE_RPC_URL", "https://base-rpc.publicnode.com"),
    explorer: "https://basescan.org",
    symbol: "ETH",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: rpc("ARBITRUM_RPC_URL", "https://arbitrum-one-rpc.publicnode.com"),
    explorer: "https://arbiscan.io",
    symbol: "ETH",
  },
  optimism: {
    key: "optimism",
    name: "OP Mainnet",
    chainId: 10,
    rpcUrl: rpc("OPTIMISM_RPC_URL", "https://optimism-rpc.publicnode.com"),
    explorer: "https://optimistic.etherscan.io",
    symbol: "ETH",
  },
  polygon: {
    key: "polygon",
    name: "Polygon PoS",
    chainId: 137,
    rpcUrl: rpc("POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com"),
    explorer: "https://polygonscan.com",
    symbol: "POL",
  },
  "base-sepolia": {
    key: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: rpc("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
    explorer: "https://sepolia.basescan.org",
    symbol: "ETH",
  },
  sepolia: {
    key: "sepolia",
    name: "Sepolia",
    chainId: 11155111,
    rpcUrl: rpc("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"),
    explorer: "https://sepolia.etherscan.io",
    symbol: "ETH",
  },
};

export function chain(key: string): ChainConfig {
  const c = CHAINS[key as ChainKey];
  if (!c) {
    throw new Error(`Unknown chain "${key}". Known: ${Object.keys(CHAINS).join(", ")}`);
  }
  return c;
}

/** Resolve a configured chain by numeric chainId (for cross-chain intent outputs). */
export function chainById(id: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === id);
}
