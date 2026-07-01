#!/usr/bin/env node
/**
 * evmsec MCP server — exposes the on-chain security checks as Model Context
 * Protocol tools so an AI agent can ask "is this contract safe to interact with?"
 * before signing a transaction, or fold an on-chain-state audit into an agentic
 * workflow. Speaks JSON-RPC over stdio.
 *
 * Run:  evmsec-mcp    (or: node dist/mcp.js)
 * Wire it into a client's mcpServers config as a stdio server.
 *
 * NOTE: stdout is the MCP protocol channel — everything here returns structured
 * results through the SDK; the check path (`assessTarget`) never writes to stdout.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CHAINS, chain } from "./config.js";
import { CheckOptions, worstSeverity } from "./check.js";
import { getProvider, requireAddress } from "./lib.js";
import { CONTRACT_CHECKS } from "./checks/registry.js";
import { assessTarget } from "./checks/run.js";

const CHAIN_KEYS = Object.keys(CHAINS);

const server = new Server({ name: "evmsec", version: "0.1.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "audit_contract",
    description:
      "Audit a deployed EVM contract's on-chain security posture: source verification, compiler-bug exposure, upgradeability, admin power (who controls it, and is it a single key), mint authority, pause guardian, and freeze/blacklist authority. Returns a structured verdict (overall severity + per-check findings). Use before interacting with an unfamiliar token/contract, or to check the contracts a protocol depends on. Reads live chain state; it is a heuristic, not a full audit.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The contract address (0x…40 hex)." },
        chain: {
          type: "string",
          enum: CHAIN_KEYS,
          description: `Chain key (default ethereum). One of: ${CHAIN_KEYS.join(", ")}.`,
        },
      },
      required: ["address"],
    },
  },
  {
    name: "list_supported_chains",
    description: "List the EVM chains evmsec can audit, with their chain ids.",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "list_supported_chains") {
      const chains = CHAIN_KEYS.map((k) => ({ chain: k, chainId: CHAINS[k as keyof typeof CHAINS].chainId }));
      return { content: [{ type: "text", text: JSON.stringify({ chains }, null, 2) }] };
    }

    if (name === "audit_contract") {
      const address = String((args as { address?: unknown }).address ?? "");
      const chainKey = String((args as { chain?: unknown }).chain ?? "ethereum");
      if (!CHAIN_KEYS.includes(chainKey))
        throw new Error(`unknown chain "${chainKey}"; one of: ${CHAIN_KEYS.join(", ")}`);

      const c = chain(chainKey);
      const provider = getProvider(c);
      const target = requireAddress(address);
      const opts: CheckOptions = { failOn: "critical" };
      const { reports } = await assessTarget(CONTRACT_CHECKS, provider, c, target, opts);

      if (reports.length === 0) {
        const text = JSON.stringify(
          { address: target, chain: c.key, overall: "skip", note: "no code at address (EOA or self-destructed)" },
          null,
          2,
        );
        return { content: [{ type: "text", text }] };
      }

      const overall = worstSeverity(reports);
      const result = {
        address: target,
        chain: c.key,
        overall,
        findings: reports.map((r) => ({
          check: r.id,
          severity: r.severity,
          summary: r.summary,
          evidence: r.evidence,
        })),
        disclaimer:
          "Heuristic aggregate of on-chain reads, not a substitute for an audit. An on-chain EOA may be backed by off-chain MPC/HSM custody evmsec cannot see.",
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the protocol channel.
  console.error("evmsec MCP server ready (stdio)");
}

main().catch((err) => {
  console.error(`evmsec MCP fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
