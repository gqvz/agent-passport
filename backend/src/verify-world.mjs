// World ID verification helpers.
//
// The client forwards the IDKit result payload as-is to the Developer Portal:
//   POST https://developer.world.org/api/v4/verify/{rp_id}
// The portal returns whether the proof is cryptographically valid and the
// nullifier embedded in the proof.
//
// Signal binding: IDKit binds proofs to a "signal" (arbitrary client string,
// here the human's wallet address). `@worldcoin/idkit-core` computes the
// committed field element as keccak256(signal bytes) >> 8 (254-bit digest). We
// reimplement that here so the backend can enforce proof-to-wallet binding in
// pure JS (no wasm startup in Node).

import { keccak256 } from "ethers";

export const WORLD_VERIFY_BASE = "https://developer.world.org/api/v4/verify";

/** The 254-bit field digest IDKit commits to for a signal string. */
export function signalHashHex(signal) {
  let input;
  if (
    signal.startsWith("0x") &&
    /^[0-9a-fA-F]+$/.test(signal.slice(2)) &&
    signal.slice(2).length % 2 === 0
  ) {
    input = Uint8Array.from(Buffer.from(signal.slice(2), "hex"));
  } else {
    input = new TextEncoder().encode(signal);
  }
  const h = BigInt(keccak256(input)) >> 8n;
  return "0x" + h.toString(16).padStart(64, "0");
}

/** Validates an IDKit result against the World ID Developer Portal. */
export async function verifyWithWorld({ rpId, idkitResponse }) {
  const res = await fetch(`${WORLD_VERIFY_BASE}/${rpId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(idkitResponse),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`World ID verification rejected: ${res.status} ${await res.text()}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`World ID verification returned an invalid JSON body (HTTP ${res.status})`);
  }
}

/** Best-effort extract a decimal nullifier string from an IDKit response. */
export function extractNullifier(idkitResponse) {
  const responses = idkitResponse?.responses ?? [];
  const first = responses[0] ?? {};
  const raw =
    first.nullifier ??
    first.session_nullifier?.[0] ??
    first.nullifier_hash;
  if (!raw) {
    throw new Error("No nullifier in IDKit response");
  }
  if (/^0x[0-9a-fA-F]+$/.test(raw)) {
    return BigInt(raw).toString(10);
  }
  return raw.toString();
}

/**
 * When a signal (e.g. wallet address) is bound into the proof, enforce that the
 * returned signal_hash matches the IDKit field digest of that signal. Legacy
 * responses include signal_hash; World ID 4.0 responses scope nullifiers to the
 * RP instead and may omit it (skipped).
 */
export function checkSignalHash(idkitResponse, signal) {
  const responses = idkitResponse?.responses ?? [];
  const signalHash = responses[0]?.signal_hash;
  if (!signalHash || signalHash === "0x0") return;
  const expected = signalHashHex(signal);
  if (signalHash.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("signal mismatch: proof bound to another signal");
  }
}

/** Normalize helpers kept for parity with World's docs on nullifier storage. */
export function nullifierToDecimal(raw) {
  return extractNullifier({ responses: [{ nullifier: raw }] });
}