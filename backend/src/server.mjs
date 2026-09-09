// Agent Passport verifier backend (Express).
//
// Endpoints:
//   GET  /api/health
//   POST /api/rp-signature   { action } -> RP signature for the IDKit widget
//   POST /api/verify-human   { wallet, signal, idkitResponse } -> verify with World
//                             ID, then write { human, nullifier } on-chain to
//                             HumanVerification.
//
// The same nullifier can only be used once (per action). Reuse returns 409.

import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { signRequest } from "@worldcoin/idkit-core/signing";

import { verifyWithWorld, extractNullifier, checkSignalHash } from "./verify-world.mjs";
import { HumanVerifier } from "./verifier.mjs";

const required = (name) => {
  const v = process.env[name];
  if (!v) console.warn(`[agent-passport-backend] Missing env ${name} — endpoint will fail`);
  return v;
};

const WORLD_APP_ID = required("WORLD_APP_ID");
const WORLD_RP_ID = required("WORLD_RP_ID");
const WORLD_RP_SIGNING_KEY = required("WORLD_RP_SIGNING_KEY");
const WORLD_ACTION = process.env.WORLD_ACTION || "verify-agent-passport-01";
const PORT = Number(process.env.PORT || 8787);

const humanVerifier = new HumanVerifier({
  rpcUrl: required("RPC_URL"),
  privateKey: required("VERIFIER_PRIVATE_KEY"),
  humanVerificationAddress: required("HUMAN_VERIFICATION_ADDRESS"),
  confirmations: Number(process.env.CONFIRMATIONS || 1),
});

/**
 * User-facing error messages we are willing to surface to the client. Anything
 * else (RPC failures, ethers internals, arbitrary exceptions) is logged and
 * replaced with a generic message so internal details never leak.
 */
const USER_FACING_ERROR_PREFIXES = [
  "World ID verification rejected",
  "World ID verification returned",
  "signal mismatch",
  "No nullifier",
  "Invalid wallet address",
  "timed out waiting for transaction confirmations",
  "This operation was aborted",
];

function userFacingError(err) {
  const msg = typeof err?.message === "string" ? err.message : "";
  return USER_FACING_ERROR_PREFIXES.some((p) => msg.startsWith(p))
    ? msg
    : "verification failed, please retry";
}

/**
 * Build the Express app. Injectables let tests stub the World ID portal call and
 * the on-chain verifier without touching the network.
 */
export function createApp({
  verifyWithWorldFn = verifyWithWorld,
  checkSignalHashFn = checkSignalHash,
  extractNullifierFn = extractNullifier,
  humanVerifier = requiredVerifier,
  usedNullifiers = new Set(),
} = {}) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Permissive CORS so the Vite dev server / preview (localhost:5173) can call this
  // backend from the browser. Fine for a hackathon localnet deployment; restrict
  // origins before exposing publicly.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, npv: humanVerifier.verifierAddress, action: WORLD_ACTION });
  });

  app.post("/api/rp-signature", (req, res) => {
    const raw = req.body?.action;
    const action = raw === undefined || raw === null ? WORLD_ACTION : raw;
    if (typeof action !== "string" || action.length === 0) {
      return res.status(400).json({ error: "action must be a non-empty string" });
    }
    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex: WORLD_RP_SIGNING_KEY,
      action,
    });
    res.json({ rp_id: WORLD_RP_ID, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig, action });
  });

  app.post("/api/verify-human", async (req, res) => {
    const start = Date.now();
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "request body must be a JSON object" });
      }
      const { wallet, signal, idkitResponse } = body;
      if (!wallet || !isAddressLike(wallet)) {
        return res.status(400).json({ error: "wallet must be a 0x address" });
      }
      if (typeof signal !== "string" || signal.trim().length === 0) {
        return res.status(400).json({ error: "signal must be a non-empty string" });
      }
      if (!idkitResponse) {
        return res.status(400).json({ error: "idkitResponse is required" });
      }

      // 1. Contact the Developer Portal to validate the proof.
      await verifyWithWorldFn({ rpId: WORLD_RP_ID, idkitResponse });

      // 2. Enforce proof-to-signal binding. The widget binds the proof to the
      //    signal string via IDKit's 254-bit field digest (keccak256 >> 8).
      checkSignalHashFn(idkitResponse, signal);

      // 3. One nullifier, one human. Claim the nullifier SYNCHRONOUSLY (before
      //    any await) so two concurrent requests with the same nullifier cannot
      //    both pass the has() check and each write the same proof on-chain.
      const nullifier = extractNullifierFn(idkitResponse);
      if (usedNullifiers.has(nullifier)) {
        return res.status(409).json({ error: "nullifier already used", nullifier });
      }
      usedNullifiers.add(nullifier);

      // 4. Write the human verification on-chain. Release the claim on failure
      //    so a transient error doesn't permanently burn a valid proof.
      let result;
      try {
        result = await humanVerifier.verifyHuman(wallet, nullifier);
      } catch (err) {
        usedNullifiers.delete(nullifier);
        throw err;
      }

      res.json({ success: true, ...result, elapsedMs: Date.now() - start });
    } catch (err) {
      console.error("[agent-passport-backend] verify-human failed:", err?.message ?? err);
      res.status(500).json({ error: userFacingError(err) });
    }
  });

  function isAddressLike(v) {
    return /^0x[0-9a-fA-F]{40}$/.test(v);
  }

  // JSON error handler: malformed / oversized bodies must fail as JSON, not leak an
  // HTML stack trace from Express' default handler.
  app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "invalid JSON body" });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "request body too large" });
    }
    if (err) {
      console.error("[agent-passport-backend] unhandled error:", err?.message ?? err);
      return res.status(500).json({ error: "internal server error" });
    }
    next();
  });

  return app;
}

function requiredVerifier() {
  throw new Error("createApp requires a humanVerifier");
}

const app = createApp({ humanVerifier });

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  app.listen(PORT, () => {
    console.log(`[agent-passport-backend] listening on :${PORT}`);
    console.log(`  app_id=${WORLD_APP_ID} rp_id=${WORLD_RP_ID} action=${WORLD_ACTION}`);
    console.log(`  verifier=${humanVerifier.verifierAddress}`);
  });
}

export { app };