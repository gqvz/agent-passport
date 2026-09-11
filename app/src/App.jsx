import { useEffect, useState } from "react";
import { IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";
import { Contract as EthersContract, isAddress, BrowserProvider } from "ethers";

import AgentRegistrarAbi from "./abis/AgentRegistrar.json";

import {
  ADDRESSES,
  BACKEND_URL,
  ROOT_NAME,
  connectWallet,
  isHumanVerified,
  readScore,
  namehash,
  subgraphQuery,
  GRAPH_QUERIES,
  LABEL_RE,
} from "./contracts.js";

const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifError, setVerifError] = useState("");
  const [humanTx, setHumanTx] = useState(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [rpContext, setRpContext] = useState(null);
  const [rpError, setRpError] = useState("");
  const [label, setLabel] = useState("");
  const [agentAddress, setAgentAddress] = useState("");
  const [registerMsg, setRegisterMsg] = useState("");
  const [scoreNode, setScoreNode] = useState("");
  const [score, setScore] = useState(null);
  const [agents, setAgents] = useState([]);
  const [graphError, setGraphError] = useState("");
  const [graphTick, setGraphTick] = useState(0);
  const [backendInfo, setBackendInfo] = useState(null);

  useEffect(() => {
    if (!account) return;
    setVerifError("");
    isHumanVerified(account)
      .then(setVerified)
      .catch((e) => {
        setVerified(false);
        setVerifError(e.message || String(e));
      });
  }, [account, humanTx]);

  useEffect(() => {
    if (!account || verified) return;
    let cancelled = false;
    fetchWithTimeout(`${BACKEND_URL}/api/rp-signature`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: import.meta.env.VITE_WORLD_ACTION || "verify-agent-passport-01" }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`rp-signature failed: HTTP ${r.status}`);
        const ctx = await r.json();
        if (cancelled) return;
        setRpContext(ctx);
        setRpError("");
        setWidgetOpen(true);
      })
      .catch(() => {
        setRpContext(null);
        setRpError("Could not start World ID verification — backend unreachable");
      });
    return () => { cancelled = true; };
  }, [account, verified]);

  useEffect(() => {
    subgraphQuery(GRAPH_QUERIES.agents, { limit: 20 })
      .then((d) => setAgents(d.agents || []))
      .catch((e) => setGraphError(e.message));
  }, [graphTick]);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/health`)
      .then((r) => r.json())
      .then(setBackendInfo)
      .catch(() => setBackendInfo(null));
  }, []);

  async function onConnect() {
    if (connecting) return;
    setConnecting(true);
    try {
      const { signer: s, account: a } = await connectWallet();
      setSigner(s);
      setAccount(a);
    } catch (e) {
      alert(`Connect failed: ${e.message}`);
    } finally {
      setConnecting(false);
    }
  }

  // Keep wallet state in sync with MetaMask (account switch / chain switch /
  // disconnect) so write txs never sign with a stale signer.
  useEffect(() => {
    const eth = window.ethereum;
    if (!account || !eth) return;
    const onAccounts = async (accounts) => {
      if (!accounts || accounts.length === 0) {
        setAccount(null);
        setSigner(null);
        return;
      }
      setAccount(accounts[0]);
      try {
        const provider = new BrowserProvider(eth);
        setSigner(await provider.getSigner());
      } catch {
        setSigner(null);
      }
    };
    const onChain = (chainId) => {
      if (chainId !== "0xaa36a7") {
        setAccount(null);
        setSigner(null);
        setVerifError("Wallet switched to a non-Sepolia network — please switch back");
      }
    };
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [account]);

  async function registerAgent() {
    setRegisterMsg("pending...");
    try {
      if (!signer) throw new Error("connect your wallet first");
      const labelName = label.trim();
      if (!LABEL_RE.test(labelName)) throw new Error("label must be 1-63 chars of lowercase letters/digits/dashes");
      const target = agentAddress.trim() || account;
      if (target !== account && !isAddress(target)) throw new Error("agent address must be a valid 0x address");
      const contract = new EthersContract(ADDRESSES.agentRegistrar, AgentRegistrarAbi.abi, signer);
      const tx = await contract.registerAgent(labelName, account, target);
      const receipt = await tx.wait();
      const fullName = `${labelName}.${ROOT_NAME}`;
      setRegisterMsg(`Registered ${fullName} in tx ${receipt.hash} (node ${namehash(fullName)})`);
      setGraphTick((t) => t + 1);
    } catch (e) {
      setRegisterMsg(`Register failed: ${e.message}`);
    }
  }

  async function onReadScore() {
    try {
      const input = scoreNode.trim();
      if (!input) throw new Error("enter an agent label or 0x node");
      let node;
      if (input.startsWith("0x")) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(input)) throw new Error("0x node must be 32 bytes of hex");
        node = input;
      } else {
        if (!LABEL_RE.test(input)) throw new Error("invalid label (1-63 lowercase letters/digits/dashes)");
        node = namehash(`${input}.${ROOT_NAME}`);
      }
      const value = await readScore(node);
      setScore(String(value));
    } catch (e) {
      setScore(`error: ${e.message}`);
    }
  }

  return (
    <main>
      <h1>Agent Passport <span>&rarr; Reputation Graph</span></h1>
      <p className="sub">
        ENSv2 agent identities under <code>{ROOT_NAME}</code>, gated on World Selfie Check, with
        EAC-separated reputation records served by The Graph.
        {backendInfo && backendInfo.ok && <em> · backend verifier {backendInfo.npv}</em>}
      </p>

      <section>
        <h2>1 · Wallet</h2>
        {account ? (
          <div>
            <span className="addr">{account}</span>
            <span className={`badge ${verified ? "ok" : "no"}`}>
              {verified ? "human-verified (World Selfie Check)" : "not yet verified"}
            </span>
            {verifError && <span className="note err">verification query failed: {verifError}</span>}
          </div>
        ) : (
          <button onClick={onConnect} disabled={connecting}>{connecting ? "Connecting…" : "Connect wallet"}</button>
        )}
      </section>

      <section>
        <h2>2 · Prove you are a human</h2>
        {account && !verified && (
          <IDKitRequestWidget
            open={widgetOpen}
            onOpenChange={setWidgetOpen}
            app_id={import.meta.env.VITE_WORLD_APP_ID}
            action={import.meta.env.VITE_WORLD_ACTION || "verify-agent-passport-01"}
            rp_context={rpContext}
            allow_legacy_proofs={true}
            preset={selfieCheckLegacy({ signal: account })}
            environment={import.meta.env.VITE_WORLD_ENV || "production"}
            handleVerify={async (result) => {
              try {
                setVerifError("");
                const res = await fetchWithTimeout(`${BACKEND_URL}/api/verify-human`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ wallet: account, signal: account, idkitResponse: result }),
                });
                let body = {};
                try {
                  body = await res.json();
                } catch {
                  /* non-JSON failure body */
                }
                if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
                setHumanTx(body.txHash);
                setWidgetOpen(false);
              } catch (e) {
                setVerifError(e.message || String(e));
                throw e; // keep the widget's failure state
              }
            }}
            onSuccess={() => setWidgetOpen(false)}
          />
        )}
        {rpError && <div className="note err">{rpError}</div>}
        {humanTx && <div className="ok-note">On-chain verified in tx <code>{humanTx}</code></div>}
        {verified && <div className="ok-note">You are verified. Registration is unlocked.</div>}
      </section>

      <section>
        <h2>3 · Register an agent</h2>
        <div className="row">
          <input
            placeholder={`label (=> <label>.${ROOT_NAME})`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input placeholder="agent address (defaults to you)" value={agentAddress} onChange={(e) => setAgentAddress(e.target.value)} />
          <button onClick={registerAgent} disabled={!account || !verified}>Register</button>
        </div>
        {registerMsg && <div className="note">{registerMsg}</div>}
      </section>

      <section>
        <h2>4 · Reputation</h2>
        <div className="row">
          <input placeholder="agent label or 0x node" value={scoreNode} onChange={(e) => setScoreNode(e.target.value)} />
          <button onClick={onReadScore}>Read score</button>
          {score !== null && <span className="score">score: {score}</span>}
        </div>
      </section>

      <section>
        <h2>5 · Reputation graph (The Graph)</h2>
        {graphError && <div className="note err">{graphError}</div>}
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Score</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td><code>{a.fullName}</code></td>
                <td>{a.status}</td>
                <td>{a.score ?? "—"}</td>
                <td><code>{a.owner?.isVerified ? "✓ " : ""}{a.owner?.id}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer>
        ENSv2 + The Graph + World · ETHOnline 2026 · <code>{ADDRESSES.agentRegistrar}</code>
      </footer>
    </main>
  );
}