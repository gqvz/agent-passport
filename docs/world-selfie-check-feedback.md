# World Selfie Check — Developer Experience Write-up

Track: World · Integration: `@worldcoin/idkit` v4 (Selfie Check) + Developer Portal verify API

## TL;DR

Selfie Check is World's **proof of personhood with a liveness / face check**. Unlike the core
World ID proof (which only proves "one unique human per phone/identity"), Selfie Check proves
the *present, live* human is behind the request — the abuse-prevention signal our Agent Passport
gate needs: one human, one set of agents, no sock-puppet farms.

## Flow implemented (beta, IDKit 4.0)

1. **Frontend** (`app/`) renders `IDKitRequestWidget` with `preset={orbLegacy({ signal: wallet })}`.
   The widget performs the Selfie Check (camera + liveness) and returns a signed result payload.
2. **Backend** (`backend/src/server.mjs`) forwards that payload unchanged to
   `POST https://developer.world.org/api/v4/verify/{rp_id}` — the only accepted way to confirm a
   proof in beta (no local signature verification of arbitrary proofs; you must check with World).
3. On success, the backend:
   - enforces *one nullifier, one human* (reuse → 409) and, when present, checks the proof's
     `signal_hash` binds to the wallet address (`keccak256(signal)`),
   - writes `HumanVerification.verifyHuman(wallet, nullifier)` on Sepolia ENSv2 contracts.
4. `HumanVerification` then writes the EAC-protected `human-verified` text record on the human's
   agent name (only this contract holds that key's write role). A human can now call
   `AgentRegistrar.registerAgent`; a non-verified address reverts with `NotHumanVerified`.

## What "verified human" means on-chain

`verifyHuman` is guarded by an immutable `VERIFIER` address (our backend). The flag is binary for
now; uniqueness is enforced by nullifier reuse rejection. This maps directly to the
`isHumanVerified` check in `AgentRegistrar.registerAgent` (`src/AgentRegistrar.sol:127`).

## Test plan + limitations found

- Sandbox App is World's only open path to test proofs without production identity data. We wired
  the app to it (`environment="staging"` on the widget) but **an `app_id`, `rp_id` and RP signing
  key are still required** from a World Developer Portal account to generate/present the widget.
- Signed-in development needs the same three credentials; without them the widget cannot obtain a
  proof, so the full human loop is not runnable headlessly in this env. On-chain EAC separation is
  nevertheless proven in `test/fork/ForkIntegration.t.sol` and `script/ForkDemo.s.sol` by granting
  the verifier role to a demo key.
- The custom action for a *Selfie Check* app must be flipped on in the Developer Portal; only
  pre-approved actions produce verifiable proofs.
- `verify/humans` API 4.0: `responses[0].nullifier_hash` was the legacy field; 4.0 moves to
  `session_nullifier` / `nullifier` — our `extractNullifier` handles all three shapes so the
  backend does not break if World changes response casing/shape.

## Suggestions back to World (feedback)

1. **Sandbox onboarding**: allow creating an app scoped to the Sandbox environment *only* (no
   production toggle first), so judges/hackers hit fewer guard rails before "it works".
2. **RP signing key retrieval**: the dashboard hides the private key after creation — offer a
   `world rp signing-key rotate` flow instead of forcing key loss on object-store migration.
3. **Signal-hash binding**: 4.0 responses don't always include `signal_hash`; document exactly when
   it is included so backends don't skip binding.
4. Docs cross-referencing: `idkit-core/signing` (RP `signRequest`) is undocumented in the widget
   README; a one-liner "use `/signing` subpath" saves 30 min.

## Files

- `backend/src/verify-world.mjs` — Developer Portal verify + nullifier helpers (unit-tested).
- `backend/src/server.mjs` — `POST /api/rp-signature`, `POST /api/verify-human`.
- `app/src/App.jsx` — IDKit widget mount (`orbLegacy`, signal = wallet).
- `src/HumanVerification.sol` — on-chain verified-human store + EAC `human-verified` stamp.