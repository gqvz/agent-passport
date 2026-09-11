// Agent Passport MCP server.
// Exposes the reputation graph via natural-language querying tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  queries,
  gql,
  resolveIntent,
  runQuery,
  formatResult,
} from "./graph.mjs";

const SUBGRAPH_URL =
  process.env.SUBGRAPH_URL ||
  "http://127.0.0.1:8001/subgraphs/name/agent-passport";

const server = new McpServer({
  name: "agent-passport",
  version: "1.0.0",
});

server.tool(
  "list_agents",
  "List registered agents and their reputation scores.",
  { status: z.enum(["REGISTERED", "REVOKED"]).optional().describe("Filter by status") },
  async ({ status }) => {
    const data = await gql(
      SUBGRAPH_URL,
      status
        ? queries.listAgents.replace("agents(orderBy: registeredAt", `agents(where: { status: "${status}" }, orderBy: registeredAt`)
        : queries.listAgents,
    );
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "get_agent",
  "Look up a single agent by its full ENS name (e.g. algo-1.agentpassport.eth) or namehash node.",
  { name: z.string().describe("Full ENS name or 0x namehash node") },
  async ({ name }) => {
    const data = /^0x[0-9a-fA-F]{64}$/.test(name)
      ? await gql(SUBGRAPH_URL, queries.getAgentByNode, { node: name })
      : await gql(SUBGRAPH_URL, queries.getAgentByName, { name });
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "top_agents",
  "List the agents with the highest reputation scores.",
  { limit: z.number().int().positive().max(50).default(5) },
  async ({ limit }) => {
    const data = await gql(SUBGRAPH_URL, queries.agentsByScore, { rank: "desc", limit });
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "lowest_agents",
  "List the agents with the lowest reputation scores.",
  { limit: z.number().int().positive().max(50).default(5) },
  async ({ limit }) => {
    const data = await gql(SUBGRAPH_URL, queries.agentsByScore, { rank: "asc", limit });
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "agents_by_owner",
  "List agents owned by a specific verified human wallet address.",
  { owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  async ({ owner }) => {
    const data = await gql(SUBGRAPH_URL, queries.agentsByOwner, { owner: owner.toLowerCase(), limit: 50 });
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "verified_humans",
  "List humans verified through World Selfie Check and the agents they own.",
  {},
  async () => {
    const data = await gql(SUBGRAPH_URL, queries.verifiedHumans);
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "platform_stats",
  "Return aggregate stats for the Agent Passport platform.",
  {},
  async () => {
    const data = await gql(SUBGRAPH_URL, queries.platformStats);
    return { content: [{ type: "text", text: formatResult(data) }] };
  },
);

server.tool(
  "ask_agent_graph",
  "Answer a natural-language question about agents and reputation. Examples: 'who owns 0x...?', 'top 5 agents by score', 'how many agents?', 'verified humans', 'reputation of algo-1'.",
  { question: z.string() },
  async ({ question }) => {
    const intent = resolveIntent(question);
    const data = await runQuery(SUBGRAPH_URL, intent);
    return {
      content: [{ type: "text", text: `Intent: ${intent.kind}\n\n${formatResult(data)}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);