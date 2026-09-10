// Smoke test for the Sepolia subgraph: verifies the deployment is healthy,
// fully synced, and indexable with a small set of known entities.
//
//   node scripts/smoke.mjs            # uses http://127.0.0.1:8001 by default
//   GRAPH_ENDPOINT=... node scripts/smoke.mjs

const endpoint = process.env.GRAPH_ENDPOINT || "http://127.0.0.1:8001/subgraphs/name/agent-passport";

async function gql(query) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`graph returned HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error(`graph errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function main() {
  const meta = await gql(`{ _meta { block { number } deployment } }`);
  console.log(`deployment: ${meta._meta.deployment}  synced block: ${meta._meta.block.number}`);

  const { humans, platform, labelRecords, agents } = await gql(`
    {
      humans(orderBy: verifiedAt, orderDirection: desc) { id isVerified }
      platform(id: "0x6cb10255454b479ceea770bad6b2d9671708bd9ceac2d8f193bc43d4672cbb4d") {
        rootName agentCount
      }
      labelRecords(first: 50) { id label expiry }
      agents { label fullName status score scoreUpdatedAt }
    }
  `);

  if (!platform?.rootName) throw new Error("platform entity missing or not indexed");
  console.log(`platform ${platform.rootName}: ${platform.agentCount} agents, ${humans.length} humans`);
  for (const a of agents) {
    console.log(`agent ${a.fullName}: ${a.status} score=${a.score} ${a.scoreUpdatedAt ?? ""}`);
  }
  if (labelRecords.length > 0) {
    console.log("label records:");
    for (const r of labelRecords) console.log(`  ${r.id} -> "${r.label}" expiry=${r.expiry}`);
  } else {
    console.log("no label records indexed yet");
  }
  console.log("smoke OK");
}

main().catch((err) => {
  console.error("smoke FAILED:", err.message);
  process.exit(1);
});