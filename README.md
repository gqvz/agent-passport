# Agent Passport & Reputation Graph

Agent identities on **ENSv2** gated by **World Selfie Check**, with a privacy-safe
**reputation graph** served by **The Graph** and queried in natural language via an **MCP** server.

One human ⇒ one verified wallet ⇒ a trusted set of `*.agentpassport.eth` agent subnames —
each carrying EAC-separated ownership, human-verification, and reputation records. The goal is an
abuse-prevention primitive: a script cannot spin up 50 sock-puppet agents because registering an
agent requires passing a live selfie check first.

Built for ETHOnline 2026. Targets three sponsor tracks:

| Sponsor | What the project uses |
|---|---|
| **ENS (ENSv2)** | Agent subnames on `agentpassport.eth` (Sepolia) with **Enhanced Access Control** — distinct write roles for "who owns this", "is the owner a verified human", and "what's its score" |
| **World (Selfie Check)** | Selfie Check (`@worldcoin/idkit` v4) as the human-onboarding gate and abuse-prevention signal |
| **The Graph** | Reputation subgraph indexing on-chain state, exposed through a natural-language MCP server |

---

## Contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Smart contracts](#smart-contracts)
- [Live deployment (Sepolia)](#live-deployment-sepolia)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
  - [1 · Contracts](#1--contracts)
  - [2 · Backend (World verifier)](#2--backend-world-verifier)
  - [3 · App (Vite + IDKit)](#3--app-vite--idkit)
  - [4 · Subgraph](#4--subgraph)
  - [5 · MCP (natural-language queries)](#5--mcp-natural-language-queries)
  - [Alternative: full stack with Docker](#alternative-full-stack-with-docker)
- [Tests](#tests)
- [API](#api)
- [Configuration reference](#configuration-reference)
- [Security notes](#security-notes)
- [Docs](#docs)
- [Roadmap / known gaps](#roadmap--known-gaps)
- [Submission](#submission)
- [License](#license)

---

## How it works

1. A user connects a wallet and runs a **World Selfie Check**. The frontend IDKit widget
   (beta, `app_id`/`rp_id` scoped) performs the live face/liveness proof.
2. The signed proof is sent to the **backend** (`backend/src/server.mjs`), which forwards it to
   `POST https://developer.world.org/api/v4/verify/{rp_id}` — the only sanctioned way to verify
   beta proofs. The backend enforces **one nullifier ⇒ one human** (reuse → `409`) and, when
   present, checks the proof's `signal_hash` binds to the requesting wallet.
3. On success the backend calls `HumanVerification.verifyHuman(wallet, nullifier)` on Sepolia.
   The `HumanVerification` contract is the sole holder of the `human-verified` EAC write role, so
   it stamps the ENSv2 text record.
4. A verified human calls `AgentRegistrar.registerAgent(label, owner, target)`. The registrar:
   - checks `isHumanVerified(owner)`,
   - mints/registers `<label>.agentpassport.eth` via the ENSv2 registry (single- or multi-byte label),
   - configures resolver permissions — owner write roles for the name/address records, plus roles
     for the human-verification and reputation contracts,
   - sets the initial records.
5. **Reputation**: `AgentReputation.setScore(node, label, score)` writes the score record
   (`onlyScorer`). Nobody else — not even the agent owner — can touch it.
6. **Revocation**: `AgentRegistrar.revokeAgent(label)` (`onlyPlatform`) clears the resolver records,
   revokes all owner per-name roles and the registrar's own write roles, then unregisters the name.
   Re-registering the same label later re-grants a clean permission set.

```
Human (Selfie Check proof)
   │  POST /api/verify-human
   ▼
Backend ──► World verify API ──► on-chain verifyHuman() ──► EAC 'human-verified' text record
   │
   ▼
verifyAgent.registerAgent(label) ──► ENSv2 subname ──► EAC roles (owner / human-verifier / scorer)
   │
   ▼
AgentReputation.setScore() ──► reputation record
   │
   ▼
Subgraph (indexes all of the above) ──► natural-language MCP queries
```

---

## Architecture

```
┌────────────┐   wallet tx         ┌────────────────────────────┐
│  App (Vite)│ ──────────────────► │  ENSv2 (Sepolia)            │
│  IDKit     │                     │  AgentRegistrar             │
│  MetaMask  │                     │  HumanVerification          │
└─────┬──────┘                     │  AgentReputation            │
      │ POST                        └──────────────┬─────────────┘
      │ /api/rp-signature,                         │ events
      │ /api/verify-human      ┌───────────────────▼─────────────┐
      ▼                        │  Subgraph (Graph Node)          │
┌────────────┐                 │  agent-passport v0.0.5          │
│  Backend   │                 └───────────────────┬─────────────┘
│  World ID  │                                     │ GraphQL
│  verifier  │                                     ▼
└────────────┘                 ┌──────────────────────────────┐
                               │  MCP server (stdio)           │
                               │  natural-language → GraphQL   │
                               └──────────────────────────────┘
```

Components:

- **`src/`** — Solidity (Foundry) contracts.
- **`app/`** — React/Vite frontend with the World IDKit widget.
- **`backend/`** — Express API that verifies Selfie Check proofs with World and writes
  `verifyHuman` on-chain.
- **`subgraph/`** — The Graph subgraph deployment (`agent-passport`, v0.0.5).
- **`mcp/`** — Model Context Protocol server exposing the reputation graph as query tools.
- **`docker/`** — Compose stack (postgres + ipfs + graph-node + backend + app + mcp) and the
  subgraph deploy script.

---

## Repository layout

```
.
├── src/                    # Solidity contracts + interfaces
│   ├── AgentRegistrar.sol  # register/revoke agent subnames, EAC permission setup
│   ├── HumanVerification.sol      # verified-human store + EAC stamp
│   ├── AgentReputation.sol        # EAC-separated reputation scores
│   └── interfaces/
├── test/                   # Foundry tests (20 local + 1 Sepolia fork)
├── script/                 # Deployment scripts + JSON address books
├── app/                    # Vite/React frontend (IDKit, MetaMask, subgraph view)
├── backend/                # Express verifier API (Node 22)
├── subgraph/               # The Graph subgraph (codegen/build/deploy/smoke)
├── mcp/                    # MCP server for natural-language graph queries
├── docker/                 # Compose stack + deploy-subgraph.sh
├── docker-compose.yml
├── RUNBOOK.md              # Full operations manual (all stacks, gotchas)
├── docs/                   # Sponsor-facing write-ups
└── project.md              # Pitch / sponsor-track framing
```

---

## Smart contracts

All contracts deploy on **Sepolia ENSv2**. Addresses live in `app/src/contracts.js` and
`app/.env.example`.

### `AgentRegistrar`
- `registerAgent(string label, address owner, address target)`
  Requires `HUMAN_VERIFICATION.isHumanVerified(owner)`. Registers `<label>.agentpassport.eth`,
  configures resolver permissions, sets initial `addr`/`name` records.
- `revokeAgent(string label) → bytes32 node` — `onlyPlatform`; clears records, revokes owner +
  registrar per-name roles, unregisters the name.
- `_configureResolverPermissions(node, owner, target, humanVerificationEAC)` — grants/underwrites
  the EAC role bitmaps on the PermissionedResolver for owner, human-verification, and reputation.

### `HumanVerification`
- `verifyHuman(address human, uint256 nullifierHash)` — `onlyVerifier` (the backend key).
- `revokeHuman(address human)` — `onlyVerifier`.
- `isHumanVerified(address human) → bool`.
- `ensureHumanVerifiedRecord(bytes32 node, bytes calldata)` — re-asserts the EAC `human-verified`
  text record (ACL-free by design; the resolver EAC gates the actual write to this contract).

### `AgentReputation`
- `setScore(bytes32 node, string label, uint256 score)` — `onlyScorer`.
- `readScore(bytes32 node) → uint256` — reads the EAC-protected `reputation` text record.

---

## Live deployment (Sepolia)

ENSv2 is Sepolia-only — this project intentionally targets testnet (do not point it at mainnet).

| Item | Value |
|---|---|
| Root name | `agentpassport.eth` |
| `AgentRegistrar` | `0xF160c7156CE7d4168b92daa9C72d1BBd64d82b2C` |
| `AgentReputation` | `0x8e85bb15D7cFAD1879F4A2D275c50528f9aBb6dB` |
| `HumanVerification` | `0x88C0a242Ab3d40b29a375393D873db200D21cB11` |
| Verifier (backend) key | `0x45837a46Cac8c927eDb577936F792889EB4ac986` |
| Subgraph | `agent-passport` v0.0.5 (local Graph Node against Sepolia) |
| RPC | `https://ethereum-sepolia-rpc.publicnode.com` |

> The Sepolia verifier key and its mnemonic live only in the gitignored
> `script/sepolia-deployer.json` / `backend/.env`. Rotate them after the event.

Indexed state (v0.0.5, smoke-verified): `algo-1.agentpassport.eth` (REGISTERED, score 88),
label record "algo-1" with node backfill + expiry, platform `agentCount` 1 (re-registering a
revoked label never double-counts), and a verified human.

---

## Prerequisites

- Node.js 20+ (Node 22 recommended)
- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`, `anvil`) — contracts
- An **ENSv2 Sepolia deployment** + a **World Developer Portal app** with `app_id`, `rp_id`, and
  RP signing key for the full human loop. Without World Sandbox credentials the IDKit widget cannot
  mint proofs — the on-chain EAC separation is still verifiable via the fork test.
- Optional: Docker for the all-in-one stack.

---

## Getting started

### 1 · Contracts

```bash
# deps: the ENSv2 stack is a git submodule + forge-std is vendored in lib/
git submodule update --init --recursive   # if you cloned fresh

forge build
forge test          # 21 tests: 20 local ENSv2 stack + 1 real-Sepolia fork
```

Deploying:

```bash
# local fork demo (see RUNBOOK §1) 
forge script script/Deploy.s.sol --fork-url https://ethereum-sepolia-rpc.publicnode.com -vvvv
# sepolia-deployer.json holds the authoritative testnet addresses (gitignored — holds real keys)
```

### 2 · Backend (World verifier)

```bash
cd backend
npm install
cp .env.example .env        # then fill in real World + verifier credentials
npm test                    # 49 tests
npm start                   # :8787 → GET /api/health, POST /api/rp-signature, POST /api/verify-human
```

### 3 · App (Vite + IDKit)

```bash
cd app
npm install
cp .env.example .env        # contract addresses + VITE_* (see Configuration reference)
npm run test                # 25 tests
npm run dev                 # http://localhost:5173 (or force on :4173 via preview build)
npm run build && npm run preview
```

### 4 · Subgraph

```bash
cd subgraph
npm install
npm run codegen && npm run build
# deploy (native Graph Node on :8021/:5001) — see docker/deploy-subgraph.sh for the compose node
./node_modules/.bin/graph create --node http://127.0.0.1:8021 agent-passport
./node_modules/.bin/graph deploy --node http://127.0.0.1:8021 --ipfs http://127.0.0.1:5001 \
  agent-passport --version-label v0.0.6
# GraphQL: http://127.0.0.1:8001/subgraphs/name/agent-passport
npm run test:smoke
```

### 5 · MCP (natural-language queries)

```bash
cd mcp
npm install
npm test                    # unit tests + live smoke
SUBGRAPH_URL=http://127.0.0.1:8001/subgraphs/name/agent-passport node src/index.mjs
```

Tools exposed: `list_agents`, `get_agent`, `top_agents`, `lowest_agents`, `agents_by_owner`,
`verified_humans`, `platform_stats`, and `ask_agent_graph` (free-form natural language → GraphQL).
Example: *"Is agent-x trustworthy, and is its owner a verified human?"* — returns the score plus
the human-verified flag from ENSv2 in one answer.

### Alternative: full stack with Docker

```bash
docker compose build
docker compose up -d postgres ipfs graph-node     # DB + indexer against real Sepolia
docker compose up -d backend app                  # API :18787, UI :4173
bash docker/deploy-subgraph.sh v0.0.5             # codegen + build + deploy to :18021 + smoke
docker compose up -d mcp                          # optional stdio broker
```

| Service | Host port(s) |
|---|---|
| postgres | – |
| ipfs | `15001` |
| graph-node | `18001` (http) · `18021` (admin) · `18031` · `18041` |
| backend | `18787` |
| app | `4173` |
| mcp | (stdio) |

See `RUNBOOK.md` §9 for the containerized-stack gotchas that were hit and fixed (postgres locale
flags, the missing `:stable` graph-node tag, etc.).

---

## Tests

| Suite | Command | Count |
|---|---|---|
| Contracts | `forge test` | **21/21** (20 local ENSv2 + 1 Sepolia fork) |
| Backend | `node --test` | **49/49** |
| App | `npm run test` | **25/25** |
| MCP | `npm test` | **4/4** (includes live subgraph smoke) |

---

## API

### `GET /api/health`
```json
{"ok": true, "npv": "0x4583…", "action": "verify-agent-passport-01"}
```

### `POST /api/rp-signature`
Body: `{ "action": "verify-agent-passport-01" }` → returns the World ID `rp_context`
(signature + merkle_root + signer) the IDKit widget needs.

### `POST /api/verify-human`
Body: `{ "wallet": "0x…", "signal": "0x…", "idkitResponse": { … } }` →
- `200` `{ success: true, txHash, human, nullifierHash, elapsedMs }` — proof accepted and written
  on-chain,
- `400` invalid/unsafe payload (non-object body, malformed wallet, etc.),
- `409` `{ error: "nullifier already used" }` — one nullifier ⇒ one human,
- `500` generic message on internal failure (details stay server-side).

---

## Configuration reference

### `backend/.env` (see `backend/.env.example`)
| Var | Purpose |
|---|---|
| `WORLD_APP_ID` | World Developer Portal app id |
| `WORLD_RP_ID` | Relayer-payload id |
| `WORLD_RP_SIGNING_KEY` | RP signing key (keep secret) |
| `WORLD_ACTION` | `verify-agent-passport-01` |
| `RPC_URL` | Sepolia RPC |
| `VERIFIER_PRIVATE_KEY` | key holding the VERIFIER role (keep secret) |
| `HUMAN_VERIFICATION_ADDRESS` | on-chain HumanVerification |
| `CONFIRMATIONS` | tx-wait confirmations (default 1) |
| `PORT` | 8787 |

### `app/.env` (see `app/.env.example`)
| Var | Purpose |
|---|---|
| `VITE_AGENT_REGISTRAR` / `VITE_AGENT_REPUTATION` / `VITE_HUMAN_VERIFICATION` | Sepolia contract addresses |
| `VITE_RPC_URL` | Sepolia RPC |
| `VITE_SUBGRAPH_URL` | subgraph GraphQL endpoint |
| `VITE_BACKEND_URL` | backend API base |
| `VITE_ROOT_NAME` | `agentpassport.eth` |
| `VITE_WORLD_APP_ID` / `VITE_WORLD_ACTION` | World app + action |
| `VITE_WORLD_ENV` | `production` (real app) or `staging` (Simulator) |

### `mcp` (env)
| Var | Purpose |
|---|---|
| `SUBGRAPH_URL` | subgraph GraphQL endpoint (default `http://127.0.0.1:8001/subgraphs/name/agent-passport`) |

---

## Security notes

- **Secrets never enter the repo.** `backend/.env`, `app/.env`, and
  `script/sepolia-deployer.json` (real Sepolia verifier key + mnemonic) are gitignored. The public
  GitHub tree was verified clean of `.env`, private keys, and token patterns.
- The backend **sanitizes all responses**: user-facing errors are allowlisted; anything else is
  logged server-side and returned as a generic message.
- Nullifier reuse is rejected **synchronously** (claim-before-await) so concurrent same-proof
  requests cannot double-write; transient failures release the claim.
- All external calls target trusted ENSv2 infrastructure — no reentrancy surface.
- **Rotate keys after ETHOnline.** The testnet verifier key has signed live deployments.
- The verifier and RP signing key should live in a secret store in any real deployment; the
  included setup is sized for a hackathon demo.

---

## Docs

- `RUNBOOK.md` — the full ops manual: seeding a Sepolia fork, native + containerized stacks,
  subgraph deploys, live status.
- `docs/world-selfie-check-feedback.md` — World Selfie Check dev-experience write-up (integration
  flow, Developer Portal navigation, Sandbox/test-user states, limitations, and suggestions).
- `project.md` — pitch and sponsor-track framing.
- `SKILL.md` — operator skill sheet: capabilities, query recipes, judge-runnable checks.
- `req.md` — the sponsor-requirement checklist this repo is audited against.

---

## Roadmap / known gaps

- **The Graph hosted endpoint**: the subgraph currently runs on a self-hosted Graph Node against
live Sepolia data. To satisfy the Graph sponsor's "live provider" requirement, deploy to
  Subgraph Studio in one command — `STUDIO_API_KEY=<key> bash docker/deploy-studio.sh` — then copy
  the printed "Queries (HTTP)" URL into `app/.env` `VITE_SUBGRAPH_URL`. (Exactly what the
  [Submission](#submission) checklist does.)
- **Demo video**: a 2–4 minute demo recording is required for submission (World + The Graph tracks).
- The `human-verified` and `reputation` records are intentionally persistent across revoke →
  re-register (they are the sponsor-facing signals; the name records are fully cleared).

---

## Submission

Pool selection and the remaining submission gate-checklist.

**Pool: Start Fresh** — this project was built from scratch for ETHOnline 2026. The only
pre-existing code it depends on is upstream ENSv2 infrastructure (the pinned
`lib/contracts-v2` submodule — identity-registry, resolver, and registrar libraries) used as a
dependency, not as prior project work; all application contracts, backend, app, subgraph, and MCP
code are original to this repo. Per the track rules: no inherited codebase, no prior
submission-reuse, so **Start Fresh** is the accurate pool.

Checklist:

| Gate | Status | Evidence / action |
|---|---|---|
| Repo public + open-source licensed | ✅ | [`LICENSE`](LICENSE) (MIT) committed; repo at `github.com/gqvz/agent-passport` |
| Subgraph on a live hosted provider | ⚠️ | run `STUDIO_API_KEY=<key> bash docker/deploy-studio.sh`, paste the "Queries (HTTP)" URL into `app/.env` `VITE_SUBGRAPH_URL`, rebuild app |
| On-chain demo data | ⚠️ | register `agentpassport.eth` platform + a few `*.agentpassport.eth` agents on Sepolia (seeded on the live deployment; see `RUNBOOK.md`) — also turns the subgraph smoke + MCP live gates green |
| Demo video (2–4 min) | ⚠️ | required for World + The Graph tracks |
| World Selfie Check feedback doc | ✅ | `docs/world-selfie-check-feedback.md` |
| Pool declaration | ✅ | this section (Start Fresh) |
| Compliance checklist | ✅ | `req.md` (audited against; see [Docs](#docs)) |

---

## License

MIT — see the [`LICENSE`](LICENSE) file. An open-source license is a hard requirement for the
Graph and ENS tracks.
