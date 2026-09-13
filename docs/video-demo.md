# Agent Passport — Video Demo Package (ETHOnline 2026)

**Duration:** 2:30 target (hard cap 3:00) · **Format:** MP4 (H.264) 1920×1080, ≤100 MB

Tracks hit: **ENSv2** (subnames + EAC permissions) · **World** (Selfie Check gate) · **The Graph** (indexed reputation + MCP query)

---

## One-line pitch

> Every agent can claim trust. Agent Passport proves there's a real human behind it.

## Logline (for the title card)

AI agents need a reputation a script can't fake. Agent Passport gates every
`*.agentpassport.eth` agent on World's Selfie Check, splits write-rights with
ENSv2's Enhanced Access Control, and serves the resulting reputation graph
through The Graph — queried in natural language via MCP.

---

## Script (2:30, ~450 spoken words)

### 0:00–0:12 — Hook

> "Somewhere on the internet, a bot just spun up its fiftieth 'trusted' agent — and you'd never know it wasn't a person."

_SCREEN: fast cut of bot-profile cards raining in, smash-cut to the scoreboard flying in. Overlay: "AGENT PASSPORT — ETHONLINE 2026"_

### 0:12–0:32 — Problem

> "Reputation only means something if it can't be gamed. Right now it can. Scripts register dozens of agents, farm scores, and answer requests with no accountable human behind the machine."

_SCREEN: split screen — a single "trusted agent" profile on the left, the same profile replicated 12× on the right. Overlay: "SYBIL" then "GAMEABLE"_

### 0:32–1:02 — The mechanism

> "Agent Passport fixes this at the identity layer. One real human → one verified wallet → a trusted set of agent names they own.
>
> First, every agent lives under `agentpassport.eth` on ENSv2, gated by World's **Selfie Check** — so creating an agent requires passing a live selfie proof, not a captcha.
>
> Second, we use ENSv2's **Enhanced Access Control** to split who can write what: who owns the agent, whether the owner is a verified human, and what its score is. Three separate roles. The agent and its owner cannot write their own reputation.
>
> Third, **The Graph** indexes that on-chain state, and we query it in natural language through an MCP server."

_SCREEN: three cards animating in — OWNERSHIP / HUMAN-VERIFIED / SCORE, each tagged "only this role can write". Arrows flow into a Graph → MCP diagram._

### 1:02–2:16 — Live demo

> "Let's do it live, on Sepolia."

1. **1:05 — Connect** — `[SCREEN: app wizard, step 1]` "A fresh wallet, never verified, so we start from zero." Watch the wallet connect.
2. **1:15 — Selfie Check** — `[SCREEN: step 2]` "World ID's Selfie Check opens — the face never leaves the phone, only a zero-knowledge proof is sent." Watch it complete → "Human verified."
3. **1:40 — Register** — `[SCREEN: step 3]` Type `algo-2`, submit → MetaMask signs → "Registered `algo-2.agentpassport.eth`."
4. **1:55 — Reputation** — `[SCREEN: Reputation page]` "The subgraph has already indexed it — here's the score, and here it is on the live scoreboard next to our other agents."
5. **2:05 — MCP query** _(optional but strong for the Graph track)_ — `[SCREEN: terminal / MCP call]` "Ask: is `algo-2` verified, and what's its score?" Show the natural-language answer.

_SCREEN: keep the cursor slow and deliberate. The txn hash and the scoreboard updating are the money shots — find them, hold on them._

### 2:16–2:24 — Close

> "One human, one verified wallet, an abuse-resistant set of agents — and a reputation only a real person can earn. Agent Passport."

### 2:24–2:30 — Outro card

_SCREEN: logo + "ENS · World ID Selfie Check · The Graph" + `github.com/gqvz/agent-passport`_

---

## Shot list (cut plan)

| # | Length | Shot |
|---|--------|------|
| 1 | 2s | Hook fast-cut → black |
| 2 | 3s | Title card |
| 3 | 10s | Problem split-screen |
| 4 | 10s | Mechanism cards |
| 5 | 10s | Architecture one-liner (reuse title-card bg) |
| 6 | 70s | Live demo — hard-cut between the 4 magic moments |
| 7 | 6s | Close + outro card |

_Magic moments to hard cut between: (a) wallet connected, (b) selfie check done, (c) txn signed, (d) agent appears on scoreboard._

---

## Prep checklist

### Wallet & chain
- Fresh MetaMask account (never used for anything) — the demo "unverified" wallet.
- Fund it with Sepolia ETH for the register tx.
- Network set to Sepolia before recording.

### Running stack (start in order)
- `docker compose up -d` → backend `:18787`, app `:4173`, subgraph `:18001` (+ ipfs, admin).
- Verify before recording: app HTTP 200 · `GET /api/health` 200 · subgraph query returns the existing humans (`algo-1`, `frfrcrazy`, and one more) so the scoreboard is not empty.

### World ID — the one risky part
- App built with `VITE_WORLD_ENV=sandbox` (already baked in the live bundle) so the widget launches the sandbox World App.
- **Sandbox Selfie Check (Beta) needs the feature flag enabled for the app** via your World point of contact. Confirm before recording that the sandbox modal actually completes.

### Fallback plan (if the sandbox selfie check dies on camera)
1. Pre-verify the demo wallet off-camera (or use an already-verified account, e.g. `0x31e4...e12` for `algo-1.agentpassport.eth`).
2. Record connect → "Human verified" (pre-existing on-chain proof) → register → scoreboard as the main flow.
3. Cut the actual selfie-check modal in as **B-roll**: re-record it in isolation (even from the phone/World App) and voice over it at step 2. It is the real flow, just not a single continuous take.

### Recording
- 1920×1080 or retina-scaled browser window; 60fps.
- Turn off notifications, browser extension popups, and the cursor trail.
- Quiet room; ~10s og song intro if you have one.

---

## Post-production & submission
- Export MP4 / H.264, 1080p, ≤100 MB, 2:30–2:45.
- Add styled captions (or clean up the autogenerated ones).
- Trim ruler if you must hit 2:00: drop the MCP demo (2:05) or trim the mechanism narration to one line. Demo + closing are non-negotiable.

---

## Backup: 30-second teaser (X/Twitter)

0:00 — "Every agent can claim trust."
0:05 — "A bot just spun up its fiftieth 'trusted' agent — and you'd never know."
0:12 — Demo fast-cuts: connect → selfie check → txn signed → onto the scoreboard.
0:22 — "One human, one verified wallet, one honest reputation. Agent Passport."
0:26 — Outro card: ENS · World ID · The Graph + link.