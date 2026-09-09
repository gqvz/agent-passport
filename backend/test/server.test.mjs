import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { app } from "../src/server.mjs";

const VERIFIER = "0x45837a46Cac8c927eDb577936F792889EB4ac986";

let server;
let base;

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("GET /api/health", () => {
  test("reports the verifier address and action", async () => {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.npv, VERIFIER);
    assert.equal(body.action, "verify-agent-passport-01");
  });
});

describe("POST /api/rp-signature", () => {
  test("signs a request for the default action", async () => {
    const { status, json } = await postJson("/api/rp-signature", {});
    assert.equal(status, 200);
    assert.equal(json.rp_id, process.env.WORLD_RP_ID);
    assert.equal(json.action, "verify-agent-passport-01");
    assert.ok(json.signature && json.nonce && json.created_at && json.expires_at);
  });

  test("honors a custom action", async () => {
    const { json } = await postJson("/api/rp-signature", { action: "custom" });
    assert.equal(json.action, "custom");
  });

  test("rejects an empty action", async () => {
    const { status, json } = await postJson("/api/rp-signature", { action: "" });
    assert.equal(status, 400);
    assert.match(json.error, /non-empty string/);
  });

  test("rejects a non-string action", async () => {
    const { status, json } = await postJson("/api/rp-signature", { action: 42 });
    assert.equal(status, 400);
    assert.match(json.error, /non-empty string/);
  });
});

describe("POST /api/verify-human validation rejects", () => {
  test("missing wallet", async () => {
    const { status, json } = await postJson("/api/verify-human", { signal: "x", idkitResponse: {} });
    assert.equal(status, 400);
    assert.match(json.error, /wallet must be a 0x address/);
  });

  test("malformed wallet", async () => {
    const { status, json } = await postJson("/api/verify-human", {
      wallet: "0x123",
      signal: "x",
      idkitResponse: {},
    });
    assert.equal(status, 400);
    assert.match(json.error, /wallet must be a 0x address/);
  });

  test("missing signal", async () => {
    const { status, json } = await postJson("/api/verify-human", {
      wallet: `0x${"a".repeat(40)}`,
      idkitResponse: {},
    });
    assert.equal(status, 400);
    assert.match(json.error, /non-empty string/);
  });

  test("non-string signal is rejected", async () => {
    const { status, json } = await postJson("/api/verify-human", {
      wallet: `0x${"a".repeat(40)}`,
      signal: 42,
      idkitResponse: {},
    });
    assert.equal(status, 400);
    assert.match(json.error, /non-empty string/);
  });

  test("whitespace-only signal is rejected", async () => {
    const { status, json } = await postJson("/api/verify-human", {
      wallet: `0x${"a".repeat(40)}`,
      signal: "   ",
      idkitResponse: {},
    });
    assert.equal(status, 400);
    assert.match(json.error, /non-empty string/);
  });

  test("oversized body returns a JSON 413", async () => {
    const res = await fetch(`${base}/api/verify-human`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "0".repeat(3_000_000) }),
    });
    const text = await res.text();
    assert.equal(res.status, 413);
    assert.ok(text.startsWith("{"), "response is JSON");
    const json = JSON.parse(text);
    assert.match(json.error, /too large/);
  });

  test("missing idkitResponse", async () => {
    const { status, json } = await postJson("/api/verify-human", {
      wallet: `0x${"a".repeat(40)}`,
      signal: "x",
    });
    assert.equal(status, 400);
    assert.match(json.error, /idkitResponse is required/);
  });

  test("malformed JSON body returns a JSON error, not an HTML page", async () => {
    const res = await fetch(`${base}/api/verify-human`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.ok(text.startsWith("{"), "response is JSON");
    const json = JSON.parse(text);
    assert.match(json.error, /invalid JSON body/);
  });

  test("invalid proof is rejected with a 500 and the portal message", async () => {
    const { status, json } = await postJson("/api/verify-human", {
      wallet: `0x${"a".repeat(40)}`,
      signal: `0x${"a".repeat(40)}`,
      idkitResponse: { responses: [] },
    });
    assert.equal(status, 500);
    assert.ok(json.error);
  });
});