// Contract wiring for the Agent Passport UI.
// Addresses default to the ones in `.env.example`; Vite exposes VITE_* env vars.
import { Contract, JsonRpcProvider, BrowserProvider, concat, id, keccak256 } from "ethers";

import AgentRegistrarAbi from "./abis/AgentRegistrar.json";
import AgentReputationAbi from "./abis/AgentReputation.json";
import HumanVerificationAbi from "./abis/HumanVerification.json";

const env = (k, dflt) => import.meta.env[k] || dflt;

// Live Sepolia deployment (ENSv2 x World Selfie Check).
export const ADDRESSES = {
  agentRegistrar: env("VITE_AGENT_REGISTRAR", "0xF160c7156CE7d4168b92daa9C72d1BBd64d82b2C"),
  agentReputation: env("VITE_AGENT_REPUTATION", "0x8e85bb15D7cFAD1879F4A2D275c50528f9aBb6dB"),
  humanVerification: env("VITE_HUMAN_VERIFICATION", "0x88C0a242Ab3d40b29a375393D873db200D21cB11"),
};

export const RPC_URL = env("VITE_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
export const SUBGRAPH_URL = env("VITE_SUBGRAPH_URL", "http://127.0.0.1:8001/subgraphs/name/agent-passport");
export const BACKEND_URL = env("VITE_BACKEND_URL", "http://localhost:8787");
export const ROOT_NAME = env("VITE_ROOT_NAME", "agentpassport.eth");

// Single DNS label: 1-63 bytes, lowercase alnum + hyphens, no leading/trailing
// hyphen, no dots. Must mirror `_isValidLabel` in AgentRegistrar.sol.
export const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const provider = new JsonRpcProvider(RPC_URL);

export function readOnlyContracts() {
  return {
    humanVerification: new Contract(ADDRESSES.humanVerification, HumanVerificationAbi.abi, provider),
    agentReputation: new Contract(ADDRESSES.agentReputation, AgentReputationAbi.abi, provider),
  };
}

/** Namehash of `name` (standard ENS algorithm). */
export function namehash(name) {
  const labels = name.split(".");
  let node = "0x" + "00".repeat(32);
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = id(labels[i]); // keccak256(utf8(label))
    node = keccak256(concat([node, labelHash]));
  }
  return node;
}

/** Ensure a connected signer for write calls. */
export async function getSignerContracts(signer) {
  return {
    agentRegistrar: new Contract(ADDRESSES.agentRegistrar, AgentRegistrarAbi.abi, signer),
    humanVerification: new Contract(ADDRESSES.humanVerification, HumanVerificationAbi.abi, signer),
    agentReputation: new Contract(ADDRESSES.agentReputation, AgentReputationAbi.abi, signer),
  };
}

const SEPOLIA_CHAIN_ID = "0xaa36a7";

/** EIP-3085 params for adding Sepolia to a wallet's network list. */
export function sepoliaChainParams() {
  return {
    chainId: SEPOLIA_CHAIN_ID,
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "SEP", decimals: 18 },
    rpcUrls: [RPC_URL],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  };
}

export async function connectWallet() {
  if (!window.ethereum) throw new Error("No injected wallet (window.ethereum) found");
  const provider = new BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_requestAccounts", []);
  const chainId = await provider.send("eth_chainId", []);
  if (chainId !== SEPOLIA_CHAIN_ID) {
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: SEPOLIA_CHAIN_ID }]);
    } catch (err) {
      const code = String(err?.code ?? err?.data?.originalError?.code ?? "");
      if (code === "4902") {
        // Sepolia is not in the wallet's network list yet — offer to add it.
        await provider.send("wallet_addEthereumChain", [sepoliaChainParams()]);
      } else {
        throw new Error(`Wrong network: this dapp runs on Sepolia (chainId ${SEPOLIA_CHAIN_ID})`);
      }
    }
    const after = await provider.send("eth_chainId", []);
    if (after !== SEPOLIA_CHAIN_ID) {
      throw new Error(`Wrong network: this dapp runs on Sepolia (chainId ${SEPOLIA_CHAIN_ID})`);
    }
  }
  return { signer: await provider.getSigner(), account: accounts[0] };
}

export async function isHumanVerified(account) {
  const { humanVerification } = readOnlyContracts();
  return humanVerification.isHumanVerified(account);
}

export async function readScore(node) {
  const { agentReputation } = readOnlyContracts();
  return agentReputation.readScore(node);
}

/** GraphQL helpers for the reputation graph view. */
export async function subgraphQuery(query, variables = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let res;
  try {
    res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`subgraph HTTP ${res.status}: ${detail}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("subgraph returned a non-JSON response");
  }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

export const GRAPH_QUERIES = {
  agents: /* GraphQL */ `
    query($limit: Int!) {
      agents(first: $limit, orderBy: score, orderDirection: desc) {
        id
        label
        fullName
        status
        score
        registeredAt
        agentAddress
        owner {
          id
          isVerified
        }
      }
    }
  `,
};