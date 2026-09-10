// GraphQL client + natural-language intent engine for the Agent Passport subgraph.
import { print } from "graphql";

/** Execute a GraphQL query against the configured subgraph endpoint. */
export async function gql(endpoint, query, variables = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL endpoint ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Reusable query fragments
// ---------------------------------------------------------------------------

const AGENT_FIELDS = /* GraphQL */ `
  id
  label
  fullName
  tokenId
  agentAddress
  registeredAt
  expiry
  status
  score
  owner {
    id
    nullifierHash
    isVerified
  }
`;

// ---------------------------------------------------------------------------
// Deterministic queries (used both directly and from the NL engine)
// ---------------------------------------------------------------------------

export const queries = {
  listAgents: /* GraphQL */ `
    query {
      agents(orderBy: registeredAt, orderDirection: desc) {
        ${AGENT_FIELDS}
      }
    }
  `,
  getAgentByName: /* GraphQL */ `
    query($name: String!) {
      agents(where: { fullName: $name }) {
        ${AGENT_FIELDS}
      }
    }
  `,
  getAgentByNode: /* GraphQL */ `
    query($node: ID!) {
      agent(id: $node) {
        ${AGENT_FIELDS}
      }
    }
  `,
  agentsByScore: /* GraphQL */ `
    query($rank: OrderDirection!, $limit: Int!) {
      agents(first: $limit, orderBy: score, orderDirection: $rank) {
        ${AGENT_FIELDS}
      }
    }
  `,
  agentsByOwner: /* GraphQL */ `
    query($owner: String!, $limit: Int!) {
      humans(where: { id: $owner }) {
        id
        agents(first: $limit) {
          ${AGENT_FIELDS}
        }
      }
    }
  `,
  verifiedHumans: /* GraphQL */ `
    query {
      humans(where: { isVerified: true }) {
        id
        nullifierHash
        verifiedAt
        agents {
          fullName
          status
          score
        }
      }
    }
  `,
  platformStats: /* GraphQL */ `
    query {
      platforms {
        id
        rootName
        agentCount
      }
      agents(where: { status: "REGISTERED" }) {
        id
      }
    }
  `,
};

// ---------------------------------------------------------------------------
// Natural-language intent engine
// ---------------------------------------------------------------------------

/** Guess which query a natural-language request maps to. */
export function resolveIntent(text) {
  const t = ` ${text.toLowerCase()} `;
  const pick = (re, li, ri) => {
    const m = text.match(re);
    return li !== undefined && m && m[li] !== undefined ? m[li].trim() : li !== undefined && m ? m[li].trim() : ri;
  };

  if (/(\b0x[0-9a-f]{40}\b)/i.test(t)) {
    const owner = text.match(/(\b0x[0-9a-f]{40}\b)/i)[1];
    return { kind: "agentsByOwner", owner };
  }
  const nameAfterWords = text.match(
    /(?:(?:reputation|score)\s+(?:of|for)\s+(?:agent\s+)?|(?:the\s+)?agent\s+(?:named|called)\s+|tell me about\s+(?:agent\s+)?|about\s+agent\s+|show me\s+(?:the\s+)?(?:agent\s+)?|what is\s+(?:the\s+)?(?:reputation|score)\s+(?:of|for)\s+(?:agent\s+)?|agent\s+([a-z0-9.-]+(?:\.agentpassport\.eth)?))\s*([a-z0-9-]+(?:\.agentpassport\.eth)?)/i,
  );
  const agentName = nameAfterWords ? nameAfterWords[2] || nameAfterWords[1] : undefined;
  if (/(reputation of|score of|about the agent|tell me about|agent named|agent called|show me the agent|what is the reputation|show me agent)/.test(t) && agentName) {
    return {
      kind: "agent",
      name: agentName.includes(".eth") ? agentName : `${agentName}.agentpassport.eth`,
    };
  }
  if (/top|highest|best|leading/.test(t) && /score|reput|rank/.test(t)) {
    return { kind: "topAgents", limit: 5 };
  }
  if (/lowest|worst|bottom/.test(t) && /score|reput/.test(t)) {
    return { kind: "lowestAgents", limit: 5 };
  }
  if (/how many agents|total agents|agent count|platform stats|count of agents/.test(t)) {
    return { kind: "platformStats" };
  }
  if (/list all agents|all agents|every agent/.test(t)) {
    return { kind: "listAgents" };
  }
  if (/verified humans|how many humans|humans verified|unique humans/.test(t)) {
    return { kind: "verifiedHumans" };
  }
  if (/(?:reputation|score)s?\b/.test(t) && /agent/.test(t)) {
    return { kind: "listAgents" };
  }
  return { kind: "listAgents" };
}

export async function runQuery(endpoint, intent) {
  switch (intent.kind) {
    case "agent":
      return gql(endpoint, queries.getAgentByName, { name: intent.name });
    case "agentsByOwner":
      return gql(endpoint, queries.agentsByOwner, { owner: intent.owner.toLowerCase(), limit: 50 });
    case "topAgents":
      return gql(endpoint, queries.agentsByScore, { rank: "desc", limit: intent.limit });
    case "lowestAgents":
      return gql(endpoint, queries.agentsByScore, { rank: "asc", limit: intent.limit });
    case "platformStats":
      return gql(endpoint, queries.platformStats);
    case "verifiedHumans":
      return gql(endpoint, queries.verifiedHumans);
    case "listAgents":
    default:
      return gql(endpoint, queries.listAgents);
  }
}

/** Format query results into a readable text card. */
export function formatResult(data) {
  if (data.agent) return formatAgent(data.agent);
  if (data.platforms) {
    const p = data.platforms[0];
    if (p)
      return `Platform ${p.rootName}: ${p.agentCount} agents ever registered; ${
        data.agents?.length ?? 0
      } currently REGISTERED.`;
  }
  if (data.agents) return data.agents.map(formatAgent).join("\n\n") || "No agents found.";
  if (data.humans) {
    return data.humans
      .map(
        (h) =>
          `Human ${h.id}${
            h.nullifierHash || h.verifiedAt
              ? `\n  nullifier: ${h.nullifierHash}\n  verifiedAt: ${h.verifiedAt}`
              : ""
          }\n  agents: ${
            h.agents?.map((a) => `${a.fullName} (${a.status}, score ${a.score ?? "n/a"})`).join(", ") || "none"
          }`
      )
      .join("\n") || "No verified humans found.";
  }
  return JSON.stringify(data, null, 2);
}

function formatAgent(a) {
  return [
    `${a.fullName} (${a.status})`,
    `  node: ${a.id}`,
    `  agentAddress: ${a.agentAddress}`,
    `  owner: ${a.owner?.id}${a.owner?.isVerified ? " human-verified" : ""}`,
    `  score: ${a.score ?? "unscored"}`,
    `  registeredAt: ${a.registeredAt}, expiry: ${a.expiry}`,
  ].join("\n");
}