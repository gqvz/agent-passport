import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";
import { Contract as EthersContract, isAddress, BrowserProvider } from "ethers";

import AgentRegistrarAbi from "./abis/AgentRegistrar.json";

import {
  ADDRESSES,
  BACKEND_URL,
  ROOT_NAME,
  connectWallet,
  isHumanVerified,
  subgraphQuery,
  GRAPH_QUERIES,
  LABEL_RE,
} from "./contracts.js";

const FETCH_TIMEOUT_MS = 15000;
const VERIFY_STEP_LABELS = {
  idle: "Not verified yet — run the selfie check.",
  starting: "Starting World ID verification…",
  scanning: "Scan the QR with your World ID app, then follow the selfie check.",
  verifying: "Proof received — verifying and writing to the chain…",
};
const WIZARD_STEPS = [
  { num: "01", title: "Connect your wallet", sub: "Establishes who owns the agent." },
  { num: "02", title: "Prove you're human", sub: "One unique human, via World Selfie Check." },
  { num: "03", title: "Register the agent", sub: "Mints your ENSv2 name under agentpassport.eth." },
];

async function fetchWithTimeout(url, options = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pageFromHash() {
  return window.location.hash.startsWith("#/reputation") ? "reputation" : "register";
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="3.4" fill="currentColor" />
      </svg>
    </span>
  );
}

function VerifiedBadge({ verified }) {
  return (
    <span className={`badge ${verified ? "ok" : "no"}`}>
      {verified ? "human verified" : "not yet verified"}
    </span>
  );
}

export default function App() {
  const [page, setPage] = useState(pageFromHash);
  const [step, setStep] = useState(0);

  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifError, setVerifError] = useState("");
  const [humanTx, setHumanTx] = useState(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [rpContext, setRpContext] = useState(null);
  const [rpError, setRpError] = useState("");
  const [verifyStep, setVerifyStep] = useState("idle");
  const [grabbingRp, setGrabbingRp] = useState(false);
  const autoStartedRef = useRef(false);

  const [label, setLabel] = useState("");
  const [agentAddress, setAgentAddress] = useState("");
  const [registerMsg, setRegisterMsg] = useState("");
  const [registerMsgOk, setRegisterMsgOk] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [lastTx, setLastTx] = useState(null);

  const [agents, setAgents] = useState(null);
  const [graphError, setGraphError] = useState("");
  const [graphTick, setGraphTick] = useState(0);

  // Hash router: #/register (default) and #/reputation behave like separate pages.
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  // Check on-chain human status whenever the account changes or a verify tx lands.
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

  // Reset flow state when the account changes or the wallet disconnects.
  useEffect(() => {
    if (!account) {
      setStep(0);
      setVerified(false);
      return;
    }
    autoStartedRef.current = false;
    setWidgetOpen(false);
    setRpContext(null);
    setRpError("");
  }, [account]);

  const startVerification = useCallback(() => {
    if (!account || verified || grabbingRp) return;
    setGrabbingRp(true);
    setVerifyStep("starting");
    setVerifError("");
    fetchWithTimeout(`${BACKEND_URL}/api/rp-signature`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: import.meta.env.VITE_WORLD_ACTION || "verify-agent-passport-01" }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`rp-signature failed: HTTP ${r.status}`);
        const ctx = await r.json();
        setRpContext(ctx);
        setRpError("");
        setVerifyStep("scanning");
        setWidgetOpen(true);
      })
      .catch(() => {
        setRpContext(null);
        setVerifyStep("idle");
        setRpError("Could not start World ID verification — backend unreachable");
      })
      .finally(() => setGrabbingRp(false));
  }, [account, verified, grabbingRp]);

  // Entering the "Prove you're human" step auto-opens the widget once.
  useEffect(() => {
    if (step !== 1 || !account || verified) return;
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    startVerification();
  }, [step, account, verified, startVerification]);

  // Already-verified wallets cruise straight through step 2.
  useEffect(() => {
    if (verified && step === 1) {
      const t = setTimeout(() => setStep(2), 650);
      return () => clearTimeout(t);
    }
  }, [verified, step]);

  useEffect(() => {
    let cancelled = false;
    setGraphError("");
    subgraphQuery(GRAPH_QUERIES.agents, { limit: 20 })
      .then((d) => !cancelled && setAgents(d.agents || []))
      .catch((e) => !cancelled && setGraphError(e.message));
    return () => { cancelled = true; };
  }, [graphTick]);

  const myAgents = useMemo(() => {
    if (!account || !agents) return null;
    return agents.filter(
      (a) => a.owner?.id?.toLowerCase() === account.toLowerCase()
    );
  }, [account, agents]);

  const myLatestScore = myAgents?.length
    ? myAgents[0].score === null || myAgents[0].score === undefined
      ? null
      : String(myAgents[0].score)
    : null;

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

  const goTo = (i) => {
    if (i === step) return;
    setStep(i);
  };
  const goNext = () => goTo(Math.min(step + 1, WIZARD_STEPS.length - 1));
  const goBack = () => goTo(Math.max(step - 1, 0));
  const canOpenStep = (i) =>
    i < step || i === 0 || (i === 1 && !!account) || (i === 2 && !!account && verified);
  const canNext = (i) => (i === 0 ? !!account : i === 1 ? !!verified : false);

  async function registerAgent(e) {
    e?.preventDefault();
    if (registering) return;
    setRegistering(true);
    setRegisterMsg("");
    setRegisterMsgOk(false);
    try {
      if (!signer) throw new Error("connect your wallet first");
      const labelName = label.trim();
      if (!LABEL_RE.test(labelName))
        throw new Error("label must be 1-63 chars of lowercase letters, digits, or dashes");
      const target = agentAddress.trim() || account;
      if (target !== account && !isAddress(target))
        throw new Error("agent address must be a valid 0x address");
      const contract = new EthersContract(ADDRESSES.agentRegistrar, AgentRegistrarAbi.abi, signer);
      setRegisterMsg("pending...");
      const tx = await contract.registerAgent(labelName, account, target);
      const receipt = await tx.wait();
      setLastTx(receipt.hash);
      setRegisterMsg(`Registered ${labelName}.${ROOT_NAME} in tx ${receipt.hash}`);
      setRegisterMsgOk(true);
      setGraphTick((t) => t + 1);
    } catch (err) {
      setRegisterMsg(`Register failed: ${err.message}`);
      setRegisterMsgOk(false);
    } finally {
      setRegistering(false);
    }
  }

  const progressPct = registerMsgOk ? 100 : ((step + 1) / WIZARD_STEPS.length) * 100;
  const slideOffset = -step * 100;

  return (
    <>
      <main>
      <header className="topbar">
        <a className="brand" href="#/register">
          <BrandMark />
          <span className="brand-name">Sight</span>
        </a>
        <nav className="nav-tabs" aria-label="Pages">
          <a href="#/register" className={page === "register" ? "active" : ""}>Register</a>
          <a href="#/reputation" className={page === "reputation" ? "active" : ""}>Reputation</a>
        </nav>
      </header>

      {page === "reputation" ? (
        <ReputationPage
          account={account}
          myAgents={myAgents}
          myLatestScore={myLatestScore}
          agents={agents}
          graphError={graphError}
        />
      ) : (
        <>
          <section className="hero">
            <h1>
              Human-gated <span className="acc">ENSv2</span> identities.
            </h1>
            <div className="hero-meta">
              <span>{ROOT_NAME} · Sepolia</span>
              <span>World ID Selfie Check × The Graph</span>
              <span>ETHOnline ’26</span>
            </div>
          </section>

          <div className="progress-row">
            <span className="progress-meta">Register flow</span>
            <div className="progress" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="progress-meta">
              {registerMsgOk ? "done" : `${String(step + 1).padStart(2, "0")} / 03`}
            </span>
          </div>

          {registerMsgOk ? (
            <section className="completion">
              <span className="kicker">registration complete</span>
              <h2>
                {label.trim()}.{ROOT_NAME}
                <br />is yours.
              </h2>
              <p className="note">
                Your reputation is being indexed — it will appear on the scoreboard shortly.
                {lastTx && <> tx <code>{lastTx}</code></>}
              </p>
              <div className="btn-row">
                <a className="btn-primary" href="#/reputation">View Reputation &rarr;</a>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setRegisterMsgOk(false);
                    setRegisterMsg("");
                    setLabel("");
                    setAgentAddress("");
                    setStep(2);
                  }}
                >
                  Register another
                </button>
              </div>
            </section>
          ) : (
            <div className="carousel">
              <div className="carousel-window">
                <div className="carousel-track" style={{ transform: `translateX(${slideOffset}%)` }}>
                  {WIZARD_STEPS.map((s, i) => (
                    <div className={`carousel-slide ${i === step ? "active" : ""}`} key={s.num} role="group" aria-label={`Step ${i + 1}`}>
                      <span className="slide-index" aria-hidden="true">{s.num}</span>
                      <h2 className="slide-title">{s.title}</h2>
                      <p className="slide-sub">{s.sub}</p>

                      <div className="slide-body">
                        {i === 0 && (
                          <>
                            <span className="lead-label">owner · Sepolia</span>
                            <p className="step-lead">
                              Connect the wallet that will own your agent. Everything here is
                              written on-chain by you — nothing is controlled by us.
                            </p>
                            {!account ? (
                              <div className="btn-row">
                                <button className="btn-primary" onClick={onConnect} disabled={connecting}>
                                  {connecting ? "Connecting…" : "Connect wallet"}
                                </button>
                              </div>
                            ) : (
                              <div className="wallet-row">
                                <span className="addr" title={account}>{account}</span>
                                <VerifiedBadge verified={verified} />
                              </div>
                            )}
                          </>
                        )}

                        {i === 1 && (
                          <>
                            <span className="lead-label">identity · world id</span>
                            <p className="step-lead">
                              A World ID selfie check proves you&rsquo;re one unique human. Your
                              face never leaves your phone — only a zero-knowledge proof is sent.
                            </p>
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
                                onError={(errorCode, debugReport) => {
                                  console.error("[agent-passport] world id error", errorCode, debugReport);
                                  setVerifyStep("idle");
                                  setVerifError(`World ID failed: ${errorCode || "unknown error"}`);
                                }}
                                handleVerify={async (result) => {
                                  try {
                                    setVerifError("");
                                    setVerifyStep("verifying");
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
                                    setVerifyStep("idle");
                                    setWidgetOpen(false);
                                  } catch (e) {
                                    setVerifyStep("idle");
                                    setVerifError(e.message || String(e));
                                    throw e;
                                  }
                                }}
                                onSuccess={() => setWidgetOpen(false)}
                              />
                            )}
                            <div className="btn-row">
                              <button className="btn-primary" onClick={startVerification} disabled={grabbingRp || verified}>
                                {grabbingRp ? "Starting…" : verified ? "Verified" : "Open World ID selfie check"}
                              </button>
                            </div>
                            <p className={`verify-status ${verifyStep}`}>{VERIFY_STEP_LABELS[verifyStep]}</p>
                            {rpError && <div className="note err">{rpError}</div>}
                            {humanTx && <div className="ok-note">Verified on-chain in tx <code>{humanTx}</code></div>}
                            {verifError && <div className="note err">{verifError}</div>}
                          </>
                        )}

                        {i === 2 && (
                          <>
                            <span className="lead-label">identity · ENSv2</span>
                            <p className="step-lead">
                              Mint your agent&rsquo;s name under <code>{ROOT_NAME}</code> and
                              stake it to your wallet. Reputation attaches to the name, not you.
                            </p>
                            <form className="reg-form" onSubmit={registerAgent}>
                              <div className="field">
                                <label htmlFor="field-label">Agent label</label>
                                <input
                                  id="field-label"
                                  placeholder={`algo-1 → ${label || "algo-1"}.${ROOT_NAME}`}
                                  value={label}
                                  onChange={(e) => setLabel(e.target.value)}
                                />
                                <p className="hint">Lowercase letters, digits and single dashes — the first label in your registered name.</p>
                              </div>
                              <div className="field">
                                <label htmlFor="field-address">Agent address <span className="opt">(optional)</span></label>
                                <input
                                  id="field-address"
                                  placeholder="0x… defaults to you"
                                  value={agentAddress}
                                  onChange={(e) => setAgentAddress(e.target.value)}
                                />
                                <p className="hint">Leave blank to name yourself — your wallet becomes the agent.</p>
                              </div>
                            </form>
                            {registerMsg && (
                              <div className="note err">{registerMsg}</div>
                            )}
                            <div className="btn-row">
                              <button
                                className="btn-primary"
                                onClick={registerAgent}
                                disabled={!account || !verified || registering}
                              >
                                {registering ? "Registering…" : "Register agent"}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="carousel-controls">
                <button
                  className="ctrl prev"
                  onClick={goBack}
                  disabled={step === 0}
                  aria-label="Previous step"
                >
                  PREV
                </button>
                <div className="pager" role="tablist" aria-label="Steps">
                  {WIZARD_STEPS.map((s, i) => (
                    <button
                      role="tab"
                      aria-selected={i === step}
                      className={`page ${i === step ? "on" : ""} ${i < step ? "past" : ""}`}
                      key={s.num}
                      onClick={() => canOpenStep(i) && goTo(i)}
                      disabled={i !== step && !canOpenStep(i)}
                    >
                      {s.num}
                    </button>
                  ))}
                </div>
                <button
                  className="ctrl next"
                  onClick={goNext}
                  disabled={!canNext(step)}
                  aria-label="Next step"
                >
                  NEXT
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <Footer />
      </main>
    </>
  );
}

function ReputationPage({ myAgents, myLatestScore, agents, graphError }) {
  return (
    <>
      <section className="rep-hero">
        <h1>
          Reputation, <span className="acc">on-chain.</span>
        </h1>
        <div className="hero-meta">
          <span>the graph index</span>
          <span>EAC-separated scoring</span>
          <span>Sight / Sepolia</span>
        </div>
      </section>

      <section className="rep-block">
        <span className="block-label">01 · your reputation</span>
        {myAgents === null && <p className="score-empty">Connect your wallet to see your score.</p>}
        {myAgents && myAgents.length === 0 && (
          <>
            <p className="score-empty">No agent under your wallet yet — register one above.</p>
            <div className="btn-row">
              <a className="btn-primary" href="#/register">Register an agent &rarr;</a>
            </div>
          </>
        )}
        {myAgents && myAgents.length > 0 && (
          <>
            <div className="giant-score">
              <span className="num">{myLatestScore === null ? "—" : myLatestScore}</span>
              <span className="den">/ 100</span>
            </div>
            <p className="score-caption">score · {myAgents[0].fullName}</p>
          </>
        )}
      </section>

      <section className="rep-block">
        <span className="block-label">02 · scoreboard</span>
        {graphError && <div className="note err">{graphError}</div>}
        {!graphError && agents === null && (
          <div className="skeleton" aria-hidden="true">
            {[0, 1, 2].map((r) => (
              <div className="skeleton-row" key={r}>
                <span className="skeleton-cell w-8" style={{ animationDelay: `${r * 120}ms` }} />
                <span className="skeleton-cell w-40" style={{ animationDelay: `${r * 120}ms` }} />
                <span className="skeleton-cell w-8" style={{ animationDelay: `${r * 120}ms` }} />
                <span className="skeleton-cell w-30" style={{ animationDelay: `${r * 120}ms` }} />
              </div>
            ))}
          </div>
        )}
        {!graphError && agents !== null && agents.length === 0 && (
          <>
            <p className="score-empty">No agents yet — register the first one.</p>
            <div className="btn-row">
              <a className="btn-primary" href="#/register">Register an agent &rarr;</a>
            </div>
          </>
        )}
        {!graphError && agents !== null && agents.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Owner</th>
                  <th className="score-no">Score</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a, idx) => (
                  <tr
                    key={a.id}
                    className={myAgents?.some((m) => m.id === a.id) ? "mine" : undefined}
                  >
                    <td className="rank">{String(idx + 1).padStart(2, "0")}</td>
                    <td><code>{a.fullName}</code></td>
                    <td>{a.status}</td>
                    <td><code>{a.owner?.isVerified ? "✓ " : ""}{a.owner?.id}</code></td>
                    <td className="score-no">{a.score === null || a.score === undefined ? "—" : String(a.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Footer() {
  const marqueeItem = (key) => (
    <span className="marquee-item" key={key}>
      Sight <span className="acc">×</span> ENSv2 <span className="acc">×</span> World ID
      <span className="acc"> ×</span> The Graph
    </span>
  );
  // Two identical tiled halves: translateX(-50%) crosses exactly one half, so
  // the loop is seamless, and each half is tiled wide enough to fill any viewport.
  return (
    <footer>
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[0, 1].map((half) => (
            <div className="marquee-half" key={half}>
              {Array.from({ length: 10 }, (_, i) => marqueeItem(i))}
            </div>
          ))}
        </div>
      </div>
      <div className="foot-meta">
        <span>© 2026 Sight</span>
        <span>ETHOnline 2026 · all rights reserved</span>
      </div>
    </footer>
  );
}