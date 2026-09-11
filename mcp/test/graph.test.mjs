import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { resolveIntent, runQuery, queries } from "../src/graph.mjs";

const VALID_ADDR = "0x" + "a1".repeat(20);

function withEndpoint(fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { query, variables } = JSON.parse(body);
      let data;
      if (query.includes("fullName: $name")) {
        data = {
          agents:
            variables.name === "algo-1.agentpassport.eth"
              ? [
                  {
                    id: "0xabcd",
                    label: "algo-1",
                    fullName: "algo-1.agentpassport.eth",
                    tokenId: "1",
                    agentAddress: "0x1111",
                    registeredAt: "100",
                    expiry: "1000",
                    status: "REGISTERED",
                    score: "94",
                    owner: { id: "0xhuman", nullifierHash: "7", isVerified: true },
                  },
                ]
              : [],
        };
      } else if (query.includes("orderBy: score")) {
        data = {
          agents: [
            { id: "0xa", label: "a", fullName: "a.agentpassport.eth", status: "REGISTERED", score: "94", owner: null },
            { id: "0xb", label: "b", fullName: "b.agentpassport.eth", status: "REGISTERED", score: "11", owner: null },
          ],
        };
      } else if (query.includes("platforms")) {
        data = { platforms: [{ id: "0xroot", rootName: "agentpassport.eth", agentCount: 2 }], agents: [{ id: "0xa" }, { id: "0xb" }] };
      } else if (query.includes("isVerified: true")) {
        data = { humans: [] };
      } else {
        data = { agents: [] };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data }));
    });
    server.listen(0, async () => {
      try {
        await fn(`http://localhost:${server.address().port}/graphql`);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

test("resolveIntent maps natural-language to queries", () => {
  assert.equal(resolveIntent(`who owns ${VALID_ADDR}`)?.kind, "agentsByOwner");
  assert.equal(resolveIntent("what is the reputation of algo-1")?.kind, "agent");
  assert.equal(resolveIntent("top 5 agents by score")?.kind, "topAgents");
  assert.equal(resolveIntent("how many agents does the platform have")?.kind, "platformStats");
  assert.equal(resolveIntent("list all agents")?.kind, "listAgents");
  assert.equal(resolveIntent("show me the verified humans")?.kind, "verifiedHumans");
});

test("runQuery fetches from the subgraph GraphQL endpoint", async () => {
  await withEndpoint(async (endpoint) => {
    const data = await runQuery(endpoint, { kind: "agent", name: "algo-1.agentpassport.eth" });
    assert.equal(data.agents[0].score, "94");
    assert.equal(data.agents[0].fullName, "algo-1.agentpassport.eth");

    const top = await runQuery(endpoint, { kind: "topAgents", limit: 5 });
    assert.equal(top.agents.length, 2);

    const stats = await runQuery(endpoint, { kind: "platformStats" });
    assert.equal(stats.platforms[0].agentCount, 2);
  });
});

test("queries use expected GraphQL shapes", () => {
  assert.ok(queries.listAgents.includes("fullName"));
  assert.ok(queries.getAgentByName.includes("$name"));
  assert.ok(queries.agentsByScore.includes("orderDirection: $rank"));
});

test("live Sepolia subgraph smoke (skips when graph-node is down)", async (t) => {
  const endpoint = process.env.SUBGRAPH_URL || "http://127.0.0.1:8001/subgraphs/name/agent-passport";
  let reachable = true;
  try {
    await fetch(endpoint);
  } catch {
    reachable = false;
  }
  if (!reachable) {
    t.skip("graph-node is not reachable");
    return;
  }
  const data = await runQuery(endpoint, { kind: "agent", name: "algo-1.agentpassport.eth" });
  assert.ok(Array.isArray(data.agents));
  const stats = await runQuery(endpoint, { kind: "platformStats" });
  assert.equal(stats.platforms[0].rootName, "agentpassport.eth");
});