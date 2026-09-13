# Agent Passport & Reputation Graph — Runbook

ENSv2 (Sepolia) + World Selfie Check + The Graph.

## 0. Environment

```bash
export PATH="$PATH:$HOME/.config/.foundry/bin"
```
Tests: `forge test` (21 tests: 20 local ENSv2-stack + 1 real-Sepolia fork integration).

> **Current working deployment = REAL Sepolia testnet (chain 11155111)**: `agentpassport.eth` is
> registered, the platform UserRegistry + shared resolver + 3 contracts are deployed and wired, and
> the backend / subgraph / app all point at Sepolia. See section 8 for the full live deployment. The
> local ENSv2 devnet (chain 31337) from section 6 remains as a fallback.

> **Self-test status (9 Sep 2026):** the full flow is now verified LIVE on Sepolia — `agentpassport.eth`
> registered (commit-reveal + USDC) by the funded deployer; platform stack deployed via `Deploy.s.sol`;
> on-chain E2E (verify demo human → register `algo-1.agentpassport.eth` → set reputation score) landed as
> real transactions; the subgraph indexes Sepolia at `:8001`; the backend verifies against `:8787`; and the
> app production build bakes in the Sepolia wiring. Test suite: `forge test` = 16 green (15 local + 1 fork
> against live Sepolia).

## 1. Seed a real chain (Sepolia fork) with the whole flow

> **Deprecated**: this section uses the old-generation Sepolia ENSv2 (registry 0xBDC85dD5…,
> registrar 0xa88553F4…). The live system runs the current ENSv2 deployment on real Sepolia — see
> section 8, and `test/fork/ForkIntegration.t.sol` for the up-to-date fork integration test
> (registry 0x67b728…, registrar 0xa4449a0d…).

Boot a persistent fork and land the full on-chain flow as real transactions:

```bash
bash /tmp/start_anvil.sh      # forks latest Sepolia at 127.0.0.1:8547
# impersonate the real ETHRegistrar and register <agentpassport>.eth for the platform:
cast rpc anvil_impersonateAccount 0xa88553F454b77203B0D036A05c894d555EAAa2Cc \
  --rpc-url http://127.0.0.1:8547
cast rpc anvil_setBalance 0xa88553F454b77203B0D036A05c894d555EAAa2Cc \
  0x8AC7230489E80000 --rpc-url http://127.0.0.1:8547
cast send 0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2 \
  'register(string,address,address,address,uint256,uint64)' agentpassport \
  <PLATFORM> 0x0000000000000000000000000000000000000000 \
  0x0000000000000000000000000000000000000000 \
  97409655027181761882228017414928043058140282880 18446744073709551615 \
  --unlocked --from 0xa88553F454b77203B0D036A05c894d555EAAa2Cc \
  --rpc-url http://127.0.0.1:8547
```

Then deploy the stack, verify a human, register two agents and score them (3 fresh funded
accounts: `PLATFORM_KEY` / `VERIFIER_KEY` / `HUMAN_KEY`):

```bash
PLATFORM_KEY=0x.. VERIFIER_KEY=0x.. HUMAN_KEY=0x.. forge script script/ForkDemo.s.sol \
  --rpc-url http://127.0.0.1:8547 --broadcast
```

The script prints + records `script/fork-deploy.json` (contract addresses, nodes, accounts).
Current committed values in that file are the live fork deployment (blocks 0xb1eb16..0xb1eb24)
with `algo-1` (score 94) and `trader-7` (score 82) owned by the same verified human.

Verify on-chain afterwards:

```bash
cast call <platformRegistry> "getState(uint256)((uint8,uint64,address,uint256,uint256))" $(cast keccak algo-1)
cast call <resolver> "text(bytes32,string)(string)" <algo1Node> "human-verified"
cast call <agentReputation> "readScore(bytes32)(uint256)" "<algo1Node>"
```

## 2. Subgraph — LEGACY (local devnet/fork indexing)

> **Superseded**: the live system indexes real Sepolia at `:8001` — see §8 (native stack) and §9
> (contained stack). This section documents the old local graph-node instance (`:8000/:8020/:8030/:8040`)
> that keeps serving the legacy localnet `agentpassport` deployment. Don't start it for new work.

```bash
cd subgraph
npm install && npm run codegen && npm run build
```

Local devnet index (graph-node from source; needs Postgres + IPFS — see `/tmp/boot_graph_stack.sh`).
Postgres must run with `LC_COLLATE=C, LC_CTYPE=C` (graph-node hard-requires the C locale) and the
DB must be empty: graph-node applies its own schema migrations on startup:

```bash
PGPASSWORD=graphpass psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE graph TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';"
# graph-node is now run through docker compose (see section 9); the ports below are
# legacy native-graph-node defaults this section assumes:
# --ethereum-rpc sepolia:http://127.0.0.1:8545 --ipfs http://127.0.0.1:5001
# --postgres-url postgresql://postgres:graphpass@127.0.0.1:5432/graph
# http 8000 / admin 8020 / index-node 8030 / metrics 8040
```

The RPC network label must be **`sepolia`** (not `sepolia-fork`) to match `subgraph.yaml` `network:`.

Deploy (create the name once, then every build):

```bash
cd subgraph
./node_modules/.bin/graph create agentpassport --node http://127.0.0.1:8020
./node_modules/.bin/graph deploy agentpassport --node http://127.0.0.1:8020 --ipfs http://127.0.0.1:5001
# then query:  http://127.0.0.1:8000/subgraphs/name/agentpassport  (no /graphql suffix)
```

The live-Sepolia subgraph (`agent-passport` on the `:8021` admin port) deploys with
`npm run deploy:sepolia` — see §8. The old scripts-based address substitution
(`scripts/substitute.mjs`) was removed; addresses now live directly in `subgraph.yaml`.

For the decentralized network: `npm run build` then `graph deploy --studio agent-passport` with your
Studio API key (hosted URL becomes the `SUBGRAPH_URL`).

## 3. MCP (natural-language reputation queries)

```bash
cd mcp && node --test test/graph.test.mjs   # unit tests + live smoke
SUBGRAPH_URL=http://127.0.0.1:8001/subgraphs/name/agent-passport node src/index.mjs
```

Tools: `list_agents`, `get_agent`, `top_agents`, `lowest_agents`, `agents_by_owner`,
`verified_humans`, `platform_stats`, and `ask_agent_graph` (free-form NL → GraphQL).

## 4. Backend (World Selfie Check verifier)

```bash
cd backend && npm install && cp .env.example .env && node --test test/verify-world.test.mjs
npm start   # :8787  → GET /api/health, POST /api/rp-signature, POST /api/verify-human
```

`.env` needs `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `RPC_URL`,
`VERIFIER_PRIVATE_KEY`, `HUMAN_VERIFICATION_ADDRESS`. Without World Sandbox credentials the
widget cannot mint proofs; see `docs/world-selfie-check-feedback.md`.

## 5. UI

```bash
cd app && npm run dev    # :5173 (needs vite.config.js: react plugin is required!)
```

`vite.config.js` is mandatory and ships in the repo:
- `@vitejs/plugin-react` — without it the browser crashes with `ReferenceError: React is not defined`
  (classic-JSX runtime), even though `npm run build` succeeds.
- `optimizeDeps.exclude: ["@worldcoin/idkit", "@worldcoin/idkit-core"]` — prebundling drops the
  sibling `idkit_wasm_bg.wasm`, breaking the widget (`wasm … served as application/wasm` MIME error,
  widget section stays empty). Load from source instead.
- `optimizeDeps.include: ["qrcode/lib/core/qrcode.js"]` — CJS interop for the widget's QR component
  (`SyntaxError: The requested module … does not provide an export named 'default'`).

App env (`app/.env`, see `.env.example`): `VITE_*` contract addresses, `VITE_RPC_URL`,
`VITE_SUBGRAPH_URL`, `VITE_BACKEND_URL=http://localhost:8787`, `VITE_WORLD_APP_ID`,
`VITE_WORLD_ACTION=verify-agent-passport-01`. `VITE_WORLD_ENV` unset → the widget talks to the real
(production) World cloud and hosts a live bridge session; set to `sandbox` for the World ID Sandbox app
(fake identity) or `staging` for the web simulator (`simulator.worldcoin.org`) proofs — the env must
match the proof you mint (the sandbox handoff still verifies at the production
`developer.world.org/api/v4/verify/{rp_id}`). Addresses default to the live localnet deployment via
`app/.env`.

Production build: `npm run build && npm run preview` → wasm is emitted to `dist/assets/*.wasm` and
served as `application/wasm` (verified).

## ~~Current live deployment (Sepolia fork / `script/fork-deploy.json`)~~ LEGACY — superseded by §8
>
> Describes the old fork demo (`ForkDemo.s.sol`) against the old-generation Sepolia ENSv2. The live
> system is the real-Sepolia deployment in section 8; `ForkDemo.s.sol` now targets current-gen ENSv2
> and is superseded by `test/fork/ForkIntegration.t.sol`.

| Component | Address |
|---|---|
| AgentRegistrar | 0xe50D119E6f9EE9d0c38a52258a60526Eef555aC6 |
| AgentReputation | 0xfF5060b4F6E7D769bF009B19B8Ff67fd8fCE2E09 |
| HumanVerification | 0x6FfC01d8f1A7ba36f637Cac16f9F88051A68cd3C |
| platform UserRegistry | 0xc94ff6b6d54FD448a42f662240b63CEa35B1C62c |
| shared PermissionedResolver | 0x3582FFE585e2929a961E7900b7D56bf71663daC2 |
| algo-1 / trader-7 nodes | 0x049c…af46 / 0x3743…f10a (scores 94 / 82) |

Real events on the fork: `LabelRegistered`, `AgentRegistered`, `HumanVerified`,
`ScoreUpdated`, `AgentRegistered` (two).

## ~~6. Current live deployment: local ENSv2 devnet (chain 31337)~~ LEGACY — superseded by §8

> Historical devnet flow (anvil `:8545` + graph-node `:8000`). The current system runs on real
> Sepolia — see section 8. A leftover fork-anvil still listening on `:8546`
> (`/tmp/anvil-sepolia-fork.log`) is not part of the boot order; kill it if present.

The hero flow runs on the ENSv2 `devnet` build's local anvil at `127.0.0.1:8545`, brought up with
`bun run devnet` inside `lib/contracts-v2/contracts` (web explorer patched to `DEVNET_WEB_PORT=8550`
so graph-node keeps port 8000).

Boot order (all steps below are currently running):

```bash
# 1. ENSv2 localnet (anvil :8545 + devnet web :8550) - 69 ENSv2 contracts, deterministic addresses
cd lib/contracts-v2/contracts && bun run devnet
# 2. Platform contracts + full hero flow (15 txs, idempotency broken - rerun together with devnet)
#    PLATFORM=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (acct[0])
#    VERIFIER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (acct[1], key 0x59c6995e...)
#    HUMAN=0x0F4723027DFe8F055c2f1DB3cB2A243D4d02740B (key in /tmp/new_wallet.txt)
PLATFORM_KEY=0xac0974be... VERIFIER_KEY=0x59c6995e... HUMAN_KEY=0x.. \
  forge script script/LocalnetDeploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow
# 3. Graph stack: postgres(C-locale) + ipfs + graph-node against :8545, fresh DB `graphlocal`
bash /tmp/boot_graph_stack.sh
#    graph-node --ethereum-rpc sepolia:http://127.0.0.1:8545 --postgres-url .../graphlocal \
#      --ipfs http://127.0.0.1:5001  (http 8000 / admin 8020)
set -a; . ../backend/.env; set +a   # (sed RPC_URL/HUMAN_VERIFICATION_ADDRESS/VERIFIER_PRIVATE_KEY)
node src/server.mjs                  # backend :8787
```

### Subgraph deploy (file-CID flow — graph-cli's recompile is buggy)

`graph build` succeeds but `graph deploy` crashes recompiling the mapping. Deploy the prebuilt bundle
by rewriting `build/subgraph.yaml` file refs to absolute `/ipfs/<cid>` links:

```bash
cd subgraph && rm -rf build && ./node_modules/.bin/graph build
# upload each ref, keep CIDs (see deploy.yaml in build/ for the current mapping)
cd build && for f in schema.graphql AgentRegistrar/AgentRegistrar.json AgentRegistrar/AgentRegistrar.wasm \
  UserRegistry/UserRegistry.json AgentReputation/AgentReputation.json HumanVerification/HumanVerification.json; do
  ipfs add -q "$f"; done
# rewrite build/deploy.yaml's file: refs to /ipfs/<each cid>, ipfs add -q deploy.yaml -> <CID>
curl -s -X POST http://127.0.0.1:8020 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"subgraph_create","params":{"name":"agentpassport"}}'
curl -s -X POST http://127.0.0.1:8020 -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"subgraph_deploy\",\"params\":{\"name\":\"agentpassport\",\"ipfs_hash\":\"<CID>\",\"node_id\":\"local0\"}}"
```

### Localnet addresses (`script/localnet-deploy.json`)

| Component | Address |
|---|---|
| AgentRegistrar | 0x3155755b79aA083bd953911C92705B7aA82a18F9 |
| AgentReputation | 0x3347B4d90ebe72BeFb30444C9966B2B990aE9FcB |
| HumanVerification | 0x276C216D241856199A83bf27b2286659e5b877D3 |
| platform UserRegistry | 0xEc8db21d81E0e5d8964F7a8A327e69C749055662 |
| shared PermissionedResolver | 0x6d9865Ee4449b0d63Ed75fFDe6C452068e07BeE4 |
| algo-1 / trader-7 nodes | 0x049c…af46 / 0x3743…f10a (scores 94 / 82) |

Live subgraph deployment (`QmQUwmXRQjh2zrTvcVbwHFb1UaW9zoMZfekAjbCARogkLj`) indexs 4 data sources
from chain 31337, synced to head; GraphQL at `http://127.0.0.1:8000/subgraphs/name/agentpassport`.
MCP: `SUBGRAPH_URL=http://127.0.0.1:8000/subgraphs/name/agentpassport node src/index.mjs`.

Live indexed state (real txs): 4 verified humans (`0x0F47…`, `0x3C44…`, `0x90F79b…`, `0xf39F…`)
and 5 agents — `algo-1` (94), `trader-7` (82), `quant-3` (88), `fresh-agent-1`, `browser-agent-1`
(last two null-score, from the 9 Sep 2026 self-test). The humans were written through the backend's
own `HumanVerifier.verifyHuman` path, proving the `/api/verify-human` contract-write loop.

> Gotcha: `AGENT_REGISTRAR` in `subgraph/src/agent-passport.ts` must be **lowercase** — graph-ts
> `Address.toHexString()` is lowercase, so any checksummed constant silently drops `LabelRegistered`
> records (labels come back empty).

## 7. Self-test: verified end-to-end checks (9 Sep 2026)

Everything here ran against the live localnet (`:8545/:8000/:8787/:5173`) and passed. Run the same
steps yourself to confirm; patterns/fixes remain reproducible.

### Before you start
- Stack must be up (section 6 boot order): anvil `:8545`, graph-node `:8000`, backend `:8787`, `npm
  run dev` on `:5173`. Check: `curl -s localhost:8787/api/health` → `{"ok":true,...}`;
  `curl -s "localhost:8000/subgraphs/name/agentpassport" -H 'content-type: application/json' -d
  '{"query":"{ humans(first:1){ id } }"}'` returns data.
- MetaMask: add chain `31337` (RPC `http://127.0.0.1:8545`) and import anvil accounts from the junk
  mnemonic. Verified humans with their keys: acct[0] `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
  / `0xac0974be…ff80`; acct[2] `0x3C44CdDdb6a900fa2b585dd299e03d12fa4293BC` / `0x5de4111a…365a`;
  acct[3] `0x90F79bf6EB2c4f870365E785982E1f101E93b906` / `0x7c852118…07a6` (fresh, verified in the
  self-test). Verifier acct[1] key `0x59c6995e…e0d` powers the backend.

### What was verified
1. **Backend API** — `node --test` from `backend/` = 49/49. `GET /api/health`; `POST /api/rp-signature`
   (nonce/signature v4 shape); `POST /api/verify-human` 200 path **and** guards: missing/`0x`-less
   wallet → 400, missing signal → 400, missing idkitResponse → 400, replayed nullifier → 409
   (`nullifier already used`), proof bound to another signal → 500 (signal mismatch). CORS verified
   from the browser origin (`OPTIONS` + `POST` to `:8787` succeed).
2. **Fresh on-chain verify** — a brand-new proof (World simulator, staging identity) for fresh wallet
   `0x90F79b…` passed the production Developer Portal (`success`, `environment: "staging"`), then
   `/api/verify-human` → 200, tx on `:8545`, `isHumanVerified(0x90F79b…)=true`,
   `nullifiers(0x90F79b…)` set, subgraph gained the 4th human. (Proving with a REAL identity is
   identical — the simulator proof is just a stand-in for your World App selfie.)
3. **Register** — UI click registered `browser-agent-1.agentpassport.eth` (tx on `:8545`), and a
   second one (`fresh-agent-1`) was registered for the fresh human; both indexed by the subgraph and
   shown by the Scoring ladder refresh without a page reload (`graphTick` refetch).
4. **Graph section** — the app's exact subgraph query returns 200 with the agent/score/owner rows
   (fixed: phantom `ScoreRank` enum variable removed → literal `orderDirection: desc`).
5. **World ID widget** — unverified wallet → widget auto-opens → shadow-DOM modal
   **"Connect your World ID … Open World ID App"** with a live `bridge.worldcoin.org` session
   (created + polling). rp-signature round-trip worked from the browser.

### User-flow gotchas (so it won't break for you)
- **One World identity = one nullifier.** The nullifier is deterministic per World ID identity and
  INDEPENDENT of signal/wallet. If you (or a previous run) already verified wallet A with your World
  App and then try wallet B with the same identity, the backend returns `409 nullifier already used`.
  Verify once, or use a fresh World App identity/"new" in World App to test a second wallet.
- **On-chain verify is idempotent** (`verifyHuman` re-sets `_verified` + `nullifiers`, no revert), so
  re-submitting after a backend restart succeeds with a new tx — no crash either way.
- **Backend `usedNullifiers` is in-memory** (resets on backend restart). Contract state is the source
  of truth for the UI badge (reads `isHumanVerified`).
- **Register is disabled until `verified`** (fetched from the contract). If the badge shows
  "not yet verified", the proof was rejected, the backend is down, or the World flow wasn't completed.
- **VITE_WORLD_ENV**: unset (default) = production World App flow. Use `staging` only for
  simulator/playground proofs (the widget environment must match the proof you mint).
- Editing `vite.config.js` or any `optimizeDeps` change requires a vite restart AND
  `rm -rf node_modules/.vite`, or you keep serving stale prebundled deps.
## 8. Current live deployment: REAL Sepolia (chain 11155111) — 9 Sep 2026

Everything below is live on the real Sepolia testnet (ENSv2 current-gen deployment from
`lib/contracts-v2/contracts/deployments/sepolia`).

### Registrar — `agentpassport.eth` registered with USDC

- Funded/owned by deployer `0x45837a46Cac8c927eDb577936F792889EB4ac986` (key in
  `script/sepolia-deployer.json`; 20 USDC + 1.7 ETH on Sepolia).
- Registered via the current-gen `ETHRegistrar` commit-reveal + fee transfer (8.000021 USDC, real USDC
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`), 1y lease → expiry **2027-09-09**.
  Register txs: commit `0x0d6636cb…`, register `0x01f3d120…`.
- **Gotcha:** the new registry mints under a *versioned* token id = `labelhash ^ (labelhash & 0xffffffff)`
  (see `LibLabel.withVersion`), NOT the raw labelhash. `ethRegistry.getOwner(0x291b4c…cae0c000000000)`
  → deployer; `findTokenId("agentpassport")` returns the same id.
- Registry queries: `getSubregistry("agentpassport")`, `getResolver("agentpassport")`, `findExpiry(name)`
  take a `string` id; `ownerOf`, `getStatus`, `getTokenId` take the `uint256` token id.

### Platform contracts (`script/Deploy.s.sol` — broadcast successful)

All 9 transactions landed (blocks ~11666731–11666742). Verified on-chain:

| Component | Address |
|---|---|
| platform UserRegistry (subregistry) | 0x29DFE8A91Ce0aCB4F3a349cD913e4E0B8c481Ae2 |
| shared PermissionedResolver | 0x60E3625313C7cD8BFF43f1FAC5Ecd90D4c1718e6 |
| HumanVerification (VERIFIER = deployer) | 0x88C0a242Ab3d40b29a375393D873db200D21cB11 |
| AgentReputation (SCORER = deployer) | 0x8e85bb15D7cFAD1879F4A2D275c50528f9aBb6dB |
| AgentRegistrar | 0xF160c7156CE7d4168b92daa9C72d1BBd64d82b2C |

- `ethRegistry.getSubregistry/getResolver("agentpassport")` → platform UserRegistry / resolver.
- `platformRegistry.hasRoles(0, REGISTRAR|RENEW|UNREGISTER, 0xF160…)` = true;
  `platformResolver.hasRoles(0, SET_*_ADMIN, 0xF160…)` = true.
- Deploy scripts/fork test use the current-gen addresses (factory 0x118Bc31A…, impl
  `0x840Fa461…`/`0x7E4B2d…`, registry 0x67b728…, registrar 0xa4449a0d…).

### On-chain E2E (live transactions)

```
verifyHuman(0x31E4dEec432deD01F79315CbB870fc1237e41e12)  # 0x94e932a6…  (backend-verifier path)
registerAgent("algo-1", human, 0x3C44…)                 # 0xf355cb80…  → tokenId 1092018…688
setScore(node, "algo-1", 88)                            # 0x076213d3…
```
Readbacks: `resolver.text(node,"name")`="algo-1", `addr`=0x3C44…, `text("human-verified")`="true",
`data(node,"reputation")`=`0x…58`, `AgentReputation.readScore(node)`=88.
**Gotcha:** the Sepolia UserRegistry mints names as ERC-1155 and rejects receivers with code that lack
`onERC1155Received`. Common demo addresses (`0x70997970…`, `0x3C44…`) carry EIP-7702 delegations on
Sepolia — use a fresh zero-code address (as above) as the owner.

### Subgraph (local graph-node instance against real Sepolia)

- Second graph-node instance: `--ethereum-rpc sepolia:https://ethereum-sepolia-rpc.publicnode.com`,
  ports **8001 / 8021(admin) / 8031 / 8041**, postgres DB `graphsepolia`, node-id `sepolia0`.
  (The first instance on :8000 keeps indexing the localnet `agentpassport`.)
- `subgraph/subgraph.yaml` now points all 4 data sources at the Sepolia addresses with real `startBlock`s
  (registrar 11666734, UserRegistry 11666728, reputation 11666733, human-verification 11666731). These
  deliberately predate the block where each contract was actually deployed (differs per contract, blocks
  0xb2052b–0xb20536) so no pre-`startBlock` on-chain events are missed — indexing from earlier is
  harmless (events simply don't exist before the contracts deployed).
- `subgraph/src/agent-passport.ts`: `AGENT_REGISTRAR` = `0xf160c7156ce7d4168b92daa9c72d1bbd64d82b2c`
  (lowercase!). Deploy:
  ```bash
  cd subgraph && ./node_modules/.bin/graph codegen && ./node_modules/.bin/graph build
  ./node_modules/.bin/graph create  --node http://127.0.0.1:8021 agent-passport
  ./node_modules/.bin/graph deploy --node http://127.0.0.1:8021 --ipfs http://127.0.0.1:5001 \
    agent-passport --version-label v<N>
  # GraphQL: http://127.0.0.1:8001/subgraphs/name/agent-passport
  ```
- Indexed (synced, v0.0.5): `algo-1.agentpassport.eth` (score 88, REGISTERED), human 0x31e4… verified,
  labelRecord "algo-1" (+`node` backfill, expiry), platform agentCount 1 (distinct agents — re-registering
  a revoked label does not double-count). Renewals keep BOTH `LabelRecord.expiry` and `Agent.expiry` in
  sync. Smoke test:
  `cd subgraph && npm run test:smoke`.

### Backend + app wiring

- `backend/.env` → Sepolia publicnode RPC, `VERIFIER_PRIVATE_KEY` = deployer (verifier), new
  `HUMAN_VERIFICATION_ADDRESS`. Health: `{"ok":true,"npv":"0x45837a…"}` on `:8787`; `/api/rp-signature`
  signs with the real World RP key.
- `app/.env` → Sepolia RPC, the 3 contract addresses, `VITE_SUBGRAPH_URL=http://127.0.0.1:8001/subgraphs/name/agent-passport`.
  Production build bakes in all of these (verified in `dist/assets/index-*.js`); preview on `:4173`.
- A real World Selfie Check proof still needs the user's phone; the Sepolia E2E demo wrote the human
  record through the verifier key (the exact path the backend's `/api/verify-human` uses).

## 9. Docker (contained stack)

Everything except the Solidity toolchain runs from `docker-compose.yml` at the repo root (hosts ports
prefixed `1` so the native stack on `:8001/:8021/:8787` keeps working if it is left running):

| Service     | Image / build                     | Host port(s)                          |
|---|---|---|
| postgres    | `postgres:16-alpine` (C locale)   | –                                    |
| ipfs        | `ipfs/kubo:v0.26.0`               | `15001`                              |
| graph-node  | `graphprotocol/graph-node:latest` | `18001`(http) `18021`(admin) `18031` `18041` |
| backend     | `backend/Dockerfile` (node 22)    | `18787`                              |
| app         | `app/Dockerfile` (vite→nginx)     | `4173`                               |
| mcp         | `mcp/Dockerfile` (stdio)          | –                                    |

> **Status (9 Sep 2026):** the stack builds and runs — postgres + ipfs + graph-node up,
> `algo-1.agentpassport.eth` indexed by the containerized Graph Node (v0.0.5, smoke OK on `:18001`),
> backend healthy on `:18787`, app served on `:4173`, and the `mcp` container queries the in-stack Graph
> Node. Gotchas that were hit and fixed:
> - The image tag is `graphprotocol/graph-node:latest` — there is **no** `:stable` tag on Docker Hub.
> - `POSTGRES_INITDB_ARGS` must fix **both** locale and encoding: with `--locale=C` alone, initdb picks
>   `SQL_ASCII` and graph-node panics with `relation "deployment_schemas" does not exist` (its locale
>   check falls through to `primary::is_empty`, which reads that not-yet-migrated table). It must be
>   `--locale-provider=libc --locale=C --encoding=UTF8`; if you hit the panic, drop the `pgdata` volume
>   and recreate (the DB was initialized with the wrong encoding).

```bash
docker compose build                       # builds app/backend/mcp images
docker compose up -d postgres ipfs graph-node   # DB + indexer against real Sepolia
docker compose up -d backend app            # API + UI (app defaults to backend :18787, graph :18001)
bash docker/deploy-subgraph.sh v0.0.5       # codegen + build + deploy to :18021 + smoke test
docker compose up -d mcp                    # optional stdio broker (attach via docker run --rm -i)
docker compose exec app sh -c 'wget -qO- http://localhost/api/health ||:'
```

App env for the image is passed as `--build-arg` (see `docker-compose.yml` `build.args`, defaults are
the live Sepolia values). Override with a `.env` file next to the compose file or `export`s, e.g.
`VITE_SUBGRAPH_URL=http://127.0.0.1:18001/subgraphs/name/agent-passport`.

`docker/deploy-subgraph.sh` builds the subgraph WASM with the host's graph-cli and points `graph deploy`
at the containerized admin port `:18021` (override with `GRAPH_NODE` / `IPFS`).
