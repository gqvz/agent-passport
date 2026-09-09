import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApp } from "../src/server.mjs";

const WALLET = `0x${"ab".repeat(20)}`;

function stubVerifier(hash = "0xabcdef") {
  return {
    verifierAddress: WALLET,
    async verifyHuman(human, nullifierHash) {
      return { txHash: hash, human, nullifierHash: String(nullifierHash) };
    },
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function post(base, path, body, contentType = "application/json") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": contentType },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("POST /api/verify-human end-to-end (stubbed world portal + verifier)", () => {
  let server;
  let base;

  before(async () => {
    const app = createApp({
      humanVerifier: stubVerifier(),
      verifyWithWorldFn: async () => ({ success: true }),
      checkSignalHashFn: () => {},
      extractNullifierFn: () => "12345",
    });
    ({ server, base } = await listen(app));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("happy path returns the success shape", async () => {
    const { status, json } = await post(base, "/api/verify-human", {
      wallet: WALLET,
      signal: WALLET,
      idkitResponse: { responses: [{ proof: ["0x"] }] },
    });
    assert.equal(status, 200);
    assert.equal(json.success, true);
    assert.equal(json.txHash, "0xabcdef");
    assert.equal(json.human, WALLET);
    assert.equal(json.nullifierHash, "12345");
    assert.equal(typeof json.elapsedMs, "number");
  });

  test("reusing the same nullifier returns 409", async () => {
    const { status, json } = await post(base, "/api/verify-human", {
      wallet: WALLET,
      signal: WALLET,
      idkitResponse: { responses: [{ proof: ["0x"] }] },
    });
    assert.equal(status, 409);
    assert.match(json.error, /nullifier already used/);
    assert.equal(json.nullifier, "12345");
  });
});

describe("POST /api/verify-human body parsing", () => {
  let server;
  let base;

  before(async () => {
    const app = createApp({ humanVerifier: stubVerifier() });
    ({ server, base } = await listen(app));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("a non-JSON content-type is a clean 400, never a 500 destructure error", async () => {
    const { status, json } = await post(base, "/api/verify-human", "wallet=0x", "text/plain");
    assert.equal(status, 400);
    assert.match(json.error, /wallet must be a 0x address/);
  });

  test("a request with no body is a clean 400", async () => {
    const res = await fetch(`${base}/api/verify-human`, { method: "POST" });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /wallet must be a 0x address/);
  });

  test("unexpected internal failures never leak details to the client", async () => {
    const failing = createApp({
      humanVerifier: stubVerifier(),
      verifyWithWorldFn: async () => {
        throw new Error("jsonrpc RPC_URL secret endpointhost internal stack");
      },
    });
    const { server: s2, base: b2 } = await listen(failing);
    try {
      const { status, json } = await post(b2, "/api/verify-human", {
        wallet: WALLET,
        signal: WALLET,
        idkitResponse: { responses: [{ proof: ["0x"] }] },
      });
      assert.equal(status, 500);
      assert.equal(json.error, "verification failed, please retry");
    } finally {
      await new Promise((resolve) => s2.close(resolve));
    }
  });
});

describe("nullifier claim lifecycle (TOCTOU guard)", () => {
  test("claims the nullifier before the on-chain call, blocking concurrent reuse", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const app = createApp({
      humanVerifier: {
        async verifyHuman() {
          await gate;
          return { txHash: "0xgg", human: WALLET, nullifierHash: "777" };
        },
      },
      verifyWithWorldFn: async () => ({}),
      checkSignalHashFn: () => {},
      extractNullifierFn: () => "777",
    });
    const { server, base } = await listen(app);
    try {
      const ac = new AbortController();
      const first = fetch(`${base}/api/verify-human`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: WALLET, signal: WALLET, idkitResponse: { responses: [{}] } }),
        signal: ac.signal,
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 50));
      const second = await post(base, "/api/verify-human", {
        wallet: WALLET,
        signal: WALLET,
        idkitResponse: { responses: [{}] },
      });
      assert.equal(second.status, 409, "second concurrent request is rejected");
      release();
      ac.abort();
      await first;
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("releases the claim when the on-chain call fails, so a retry can succeed", async () => {
    let attempts = 0;
    const app = createApp({
      humanVerifier: {
        async verifyHuman() {
          attempts += 1;
          if (attempts === 1) throw new Error("rpc exploded");
          return { txHash: "0xdd", human: WALLET, nullifierHash: "999" };
        },
      },
      verifyWithWorldFn: async () => ({}),
      checkSignalHashFn: () => {},
      extractNullifierFn: () => "999",
    });
    const { server, base } = await listen(app);
    try {
      const first = await post(base, "/api/verify-human", {
        wallet: WALLET,
        signal: WALLET,
        idkitResponse: { responses: [{}] },
      });
      assert.equal(first.status, 500);
      assert.equal(first.json.error, "verification failed, please retry");

      const second = await post(base, "/api/verify-human", {
        wallet: WALLET,
        signal: WALLET,
        idkitResponse: { responses: [{}] },
      });
      assert.equal(second.status, 200);
      assert.equal(attempts, 2, "the retry reached the verifier");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});