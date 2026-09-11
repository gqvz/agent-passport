import { describe, it, expect, vi, afterEach } from "vitest";
import { ethers } from "ethers";

import {
  ADDRESSES,
  RPC_URL,
  SUBGRAPH_URL,
  BACKEND_URL,
  ROOT_NAME,
  LABEL_RE,
  namehash,
  sepoliaChainParams,
  subgraphQuery,
} from "../src/contracts.js";

// Known ENSv2 vectors (verified against the live Sepolia deployment and the
// agent-passport subgraph, which stores `node` for algo-1).
const ROOT_NODE = "0x6cb10255454b479ceea770bad6b2d9671708bd9ceac2d8f193bc43d4672cbb4d";
const ALGO1_NODE = "0x049cb51bc99c798b89fae709de64d14f1a8624c547c7b0cfcf12ece18d52af46";

describe("namehash", () => {
  it("produces the ENSv2 root node for agentpassport.eth", () => {
    expect(namehash("agentpassport.eth")).toBe(ROOT_NODE);
  });

  it("produces the same child node the subgraph indexed for algo-1", () => {
    expect(namehash("algo-1.agentpassport.eth")).toBe(ALGO1_NODE);
  });

  it("matches ethers' namehash for a random name", () => {
    expect(namehash("foo.example")).toBe(ethers.namehash("foo.example"));
  });
});

describe("LABEL_RE (mirrors AgentRegistrar._isValidLabel)", () => {
  const ok = ["algo-1", "a", "x".repeat(63), "q", "z9-a"];
  const bad = ["", "A", "Algo-1", "a--", "-lead", "trail-", "dot.thing", "under_score", "x".repeat(64), "a.b"];

  it.each(ok)("accepts valid label %s", (s) => {
    expect(LABEL_RE.test(s)).toBe(true);
  });

  it.each(bad)("rejects invalid label %s", (s) => {
    expect(LABEL_RE.test(s)).toBe(false);
  });
});

describe("addresses & endpoints", () => {
  it("defaults to the live Sepolia deployment addresses", () => {
    expect(ADDRESSES.agentRegistrar).toBe("0xF160c7156CE7d4168b92daa9C72d1BBd64d82b2C");
    expect(ADDRESSES.agentReputation).toBe("0x8e85bb15D7cFAD1879F4A2D275c50528f9aBb6dB");
    expect(ADDRESSES.humanVerification).toBe("0x88C0a242Ab3d40b29a375393D873db200D21cB11");
    for (const addr of Object.values(ADDRESSES)) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("points at the local Sepolia graph-node and backend", () => {
    expect(RPC_URL).toMatch(/^https:\/\//);
    expect(SUBGRAPH_URL).toContain("agent-passport");
    expect(SUBGRAPH_URL).not.toContain("api.studio.thegraph.com");
    expect(BACKEND_URL).toContain("8787");
    expect(ROOT_NAME).toBe("agentpassport.eth");
  });
});

describe("sepoliaChainParams", () => {
  it("sends the FULL rpc URL (with scheme) that MetaMask requires", () => {
    const params = sepoliaChainParams();
    expect(params.chainId).toBe("0xaa36a7");
    expect(params.rpcUrls).toEqual([RPC_URL]);
    expect(params.rpcUrls[0]).toMatch(/^https?:\/\/.+/);
  });
});

describe("subgraphQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(impl) {
    vi.stubGlobal("fetch", vi.fn(impl));
  }

  it("posts the query and returns body.data on success", async () => {
    const seen = [];
    mockFetch(async (url, opts) => {
      seen.push({ url, opts });
      return { ok: true, json: async () => ({ data: { ok: 1 } }) };
    });
    const data = await subgraphQuery("{ __typename }", { a: 1 });
    expect(data).toEqual({ ok: 1 });
    expect(seen[0].url).toBe(SUBGRAPH_URL);
    expect(JSON.parse(seen[0].opts.body)).toEqual({ query: "{ __typename }", variables: { a: 1 } });
  });

  it("throws a clean error on a non-2xx HTTP response", async () => {
    mockFetch(async () => ({ ok: false, status: 500, text: async () => "boom" }));
    await expect(subgraphQuery("{ x }")).rejects.toThrow(/subgraph HTTP 500: boom/);
  });

  it("throws a clean error on a non-JSON body", async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }));
    await expect(subgraphQuery("{ x }")).rejects.toThrow(/non-JSON response/);
  });

  it("surfaces GraphQL errors from the body", async () => {
    mockFetch(async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "Unknown type" }, { message: "Second" }] }),
    }));
    await expect(subgraphQuery("{ x }")).rejects.toThrow("Unknown type; Second");
  });
});