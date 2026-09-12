# SKILL.md — Agent Passport

Agent Passport is an ETHOnline 2026 project that puts **one human = one verified wallet = a
trusted family of `*.agentpassport.eth` agents** on the chain, and makes that reputation graph
queryable in plain language.

This file is an operator skill sheet: the capabilities the project exposes, the exact commands
to run them, and the artifacts a sponsor judge should exercise. It complements `README.md`
(architecture/quickstart) and `RUNBOOK.md` (ops/seeding).

## Capabilities

| Capability | Where | How to exercise |
|---|---|---|
| Human-gated agent registration on ENSv2 | `src/AgentRegistrar.sol` | Wallet + World Selfie Check via the app, or `script/Deploy.s.sol` flows |
| Human verification records + nullifier tracking | `src/HumanVerification.sol`, backend `POST /api/verify-human` | Backend calls `verifyHuman()` with the World proof |
| EAC-separated reputation (`reputation` data key per agent) | `src/AgentReputation.sol` | Assigns read/write to the platform only |
| On-chain state → GraphQL index | `subgraph/` (schema: agents, platforms, humans, reputations) | Query the deployed endpoint (see [Querying](#querying)) |
| Natural-language queries over the graph | `mcp/src/index.mjs` (MCP server, stdio) | `npm start` in `mcp/`, then ask "top 5 agents by score" |
| Live selfie-check verification loop | `app/` (IDKit v4) + `backend/` | In-browser signature proof → server-side World verification |

## Querying

Self-hosted node (this repo):

```bash
curl -s http://127.0.0.1:18001/subgraphs/name/agent-passport \
  -H 'content-type: application/json' \
  -d '{"query":"{ platforms { rootName agentCount } agents { id owner } }"}'
```

Hosted (Subgraph Studio, after `deploy:studio`): the deploy prints `Queries (HTTP)` — that URL is
the same shape (`…/subgraphs/name/<slug>` under the Studio gateway). Set it in `app/.env`
`VITE_SUBGRAPH_URL` and `mcp/.env`/`SUBGRAPH_URL`.

The MCP server exposes the graph as tools: `getAgent`, `topAgents`, `bottomAgents`,
`agentsByOwner`, `verifiedHumans`, `platformStats`, and a free-form `query` resolver that maps
intents like `who owns <addr>` / `what is the reputation of <name>` to the GraphQL schema
(`subgraph/schema.graphql`).

## Checks a judge can run

```bash
forge test                    # 21/21  (contracts, incl. Sepolia fork integration)
cd backend && npm test        # 49/49  (verifier server, incl. World proof handling)
cd app && npm run test && npm run build   # 25/25 + production build
cd subgraph && npm run codegen && npm run build   # manifest + WASM mappings
cd subgraph && GRAPH_ENDPOINT=http://127.0.0.1:18001/subgraphs/name/agent-passport npm run test:smoke
cd mcp && SUBGRAPH_URL=http://127.0.0.1:18001/subgraphs/name/agent-passport npm test
docker compose up -d          # full stack: postgres + ipfs + graph-node + backend(:18787) + app(:4173)
```

Smoke/live gates assert a registered `platform` entity; they go green once real
`agentpassport.eth` subnames exist on-chain.

## Skills

- **Solidity / Foundry (0.8.24, evm `cancun`)**: EAC role-checks via ENSv2 `PermissionedResolver` +
  `Authority/Registrar` grants; DNS-name label validation (`_dnsEncode`); nullifier idempotency.
- **The Graph**: AssemblyScript mappings binding ENSv2 + agent contracts; multi-datasource manifest
  with per-source `startBlock`; smoke-tested GraphQL shapes.
- **World (Selfie Check v4)**: frontend `@worldcoin/idkit` integration, backend proof forwarding to
  the World Verification API, `app_id`/`rp_id`/action scoping, sandbox↔production switch.
- **Node/Express**: ESM server with a strict env `required()` gate (secrets stay in gitignored
  `.env`), validation, timeout-wrapped World RPC calls, error sanitizer.
- **MCP (stdio)**: zod-validated tools + intent→query resolution over the subgraph.
- **Infra**: compose stack (postgres/graph-node/ipfs/app/backend) + Foundry deploy scripts for
  Sepolia; subgraph deploy to Studio in one command.

## Boundaries

- The `human-verified` and `reputation` records persist across revoke → re-register by design
  (they are the sponsor-facing signals); per-name ownership/address records are fully cleared.
- Secrets live only in gitignored files (`backend/.env`, `app/.env`, `script/sepolia-deployer.json`).
- The live Sepolia deployment is testnet-scoped; rotate the verifier key after the event.