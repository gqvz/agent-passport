import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  extractNullifier,
  nullifierToDecimal,
  signalHashHex,
  checkSignalHash,
  verifyWithWorld,
} from "../src/verify-world.mjs";

test("extracts 0x nullifier to decimal", () => {
  const r = extractNullifier({
    responses: [{ identifier: "orb", nullifier: "0x02", proof: ["0x"] }],
  });
  assert.equal(r, "2");
});

test("extracts session nullifier (World ID 4.0 session)", () => {
  const r = extractNullifier({
    responses: [{ identifier: "proof_of_human", session_nullifier: ["0x01", "0x02"] }],
  });
  assert.equal(r, "1");
});

test("extracts 4.0 uniqueness nullifier", () => {
  const r = extractNullifier({ responses: [{ nullifier: "0xff" }] });
  assert.equal(r, "255");
});

test("nullifierToDecimal normalizes", () => {
  assert.equal(nullifierToDecimal("0x0A"), "10");
});

test("a raw decimal string nullifier is returned unchanged", () => {
  const r = extractNullifier({ responses: [{ nullifier: "12345" }] });
  assert.equal(r, "12345");
});

test("responses null falls through to a clean error", () => {
  assert.throws(() => extractNullifier({ responses: null }), /No nullifier/);
});

test("an empty responses array falls through to a clean error", () => {
  assert.throws(() => extractNullifier({ responses: [] }), /No nullifier/);
});

test("rejects missing nullifier", () => {
  assert.throws(() => extractNullifier({ responses: [{ identifier: "orb" }] }), /No nullifier/);
});

// ---------------------------------------------------------------------------
// signalHashHex (254-bit keccak digest that IDKit commits vs a signal string)
// ---------------------------------------------------------------------------

describe("signalHashHex", () => {
  test("matches a known keccak256 >> 8 vector", () => {
    assert.equal(signalHashHex("abc"), "0x004e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c");
    assert.equal(signalHashHex("algo-1"), "0x00f16e10f9e27683a29c3dd9ea425d9b49abc221fb9918559fff26a54313d8f6");
  });

  test("hex-string input is decoded as raw bytes (matches utf8 of the same bytes)", () => {
    // "0x616263" == the bytes of "abc"
    assert.equal(signalHashHex("0x616263"), signalHashHex("abc"));
  });

  test("is deterministic and 254-bit (first byte always < 0x04)", () => {
    const a = signalHashHex("some-signal");
    const b = signalHashHex("some-signal");
    assert.equal(a, b);
    assert.equal(a.length, 66); // 0x + 64 hex digits
    assert.ok(parseInt(a.slice(2, 4), 16) < 4);
  });
});

// ---------------------------------------------------------------------------
// checkSignalHash (proof-to-signal binding)
// ---------------------------------------------------------------------------

describe("checkSignalHash", () => {
  const h = signalHashHex("0xabc");

  test("passes when the response signal_hash matches the signal digest", () => {
    assert.doesNotThrow(() => checkSignalHash({ responses: [{ signal_hash: h }] }, "0xabc"));
  });

  test("is case-insensitive", () => {
    assert.doesNotThrow(() => checkSignalHash({ responses: [{ signal_hash: h.toUpperCase() }] }, "0xabc"));
  });

  test("throws on a mismatched signal_hash", () => {
    assert.throws(
      () => checkSignalHash({ responses: [{ signal_hash: signalHashHex("someone-else") }] }, "0xabc"),
      /signal mismatch/,
    );
  });

  test("skips when signal_hash is absent or 0x0 (World ID 4.0 responses)", () => {
    assert.doesNotThrow(() => checkSignalHash({ responses: [{ identifier: "proof_of_human" }] }, "0xabc"));
    assert.doesNotThrow(() => checkSignalHash({ responses: [{ signal_hash: "0x0" }] }, "0xabc"));
  });
});

// ---------------------------------------------------------------------------
// verifyWithWorld (Developer Portal verification call)
// ---------------------------------------------------------------------------

describe("verifyWithWorld", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("forwards the idkit response to the portal and returns json on 2xx", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ success: true }) };
    };
    const res = await verifyWithWorld({ rpId: "rp_test", idkitResponse: { x: 1 } });
    assert.deepEqual(res, { success: true });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/v4/verify/rp_test"));
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.body, JSON.stringify({ x: 1 }));
  });

  test("throws with the portal status when verification is rejected", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid proof",
    });
    await assert.rejects(verifyWithWorld({ rpId: "rp_test", idkitResponse: {} }), /World ID verification rejected: 400/);
  });

  test("binds an AbortSignal.timeout to the portal request", async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };
    await verifyWithWorld({ rpId: "rp_test", idkitResponse: {} });
    assert.ok(calls[0].opts.signal, "a signal is bound to the request");
    assert.equal(typeof calls[0].opts.signal.aborted, "boolean");
  });

  test("throws a clean error when the portal returns non-JSON on 2xx", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    await assert.rejects(
      verifyWithWorld({ rpId: "rp_test", idkitResponse: {} }),
      /invalid JSON body \(HTTP 200\)/,
    );
  });

  test("propagates a fetch/network abort with the underlying message", async () => {
    globalThis.fetch = async () => {
      const err = new Error("This operation was aborted");
      err.name = "TimeoutError";
      throw err;
    };
    await assert.rejects(verifyWithWorld({ rpId: "rp_test", idkitResponse: {} }), /aborted/);
  });
});