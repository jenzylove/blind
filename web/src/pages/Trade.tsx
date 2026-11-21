import { useCallback, useEffect, useMemo, useState } from "react";
import type { UnifiedAccount } from "@qorechain/sdk";
import { api, type BatchRec, type Quote, type State } from "../lib/api";
import {
  loadAccount, newAccount, forgetAccount, storedWords, fund, registerKey, openWindow, approveBoth,
  placeSwap, placeLimit, minOutFor, pub, type Built,
} from "../lib/chain";
import { usd, eth, short, blockNo, pct, edgeBps } from "../lib/fmt";
import { useLive, useNow, phaseStep, phaseLine, STEPS, Seal, TxLink, Copy, Link, refreshState } from "../ui";

type StepState = "todo" | "run" | "done" | "err";
interface Setup { keys: StepState; fund: StepState; key: StepState; window: StepState; approve: StepState }
const SETUP_TEXT: Record<keyof Setup, [string, string]> = {
  keys: ["Make a test account", "Keys are created in this browser, including your post quantum key."],
  fund: ["Get test funds", "15 fUSD, 0.005 fETH and 0.35 QOR for fees, from the Blind faucet."],
  key: ["Register your post quantum key", "QoreChain records your ML-DSA-87 key so the contract can check your orders."],
  window: ["Open a short EVM window", "Allows two token approvals, to fUSD and fETH only."],
  approve: ["Approve the Blind contract", "Lets settlement move the tokens you sell. Two transactions."],
};

interface Me { fUSD: bigint; fETH: bigint; qor: bigint; approved: { fUSD: boolean; fETH: boolean }; registered: boolean }

async function readMe(acc: UnifiedAccount): Promise<Me> {
  const [m, p, b] = await Promise.all([
    api.me(acc.evm),
    api.pqc(acc.cosmos).catch(() => ({ registered: false })),
    fetch(`/api/rest/cosmos/bank/v1beta1/balances/${acc.cosmos}`).then((r) => r.json()).catch(() => ({ balances: [] })),
  ]);
  const qor = BigInt((b.balances ?? []).find((x: any) => x.denom === "uqor")?.amount ?? "0");
  return { fUSD: BigInt(m.fUSD), fETH: BigInt(m.fETH), qor, approved: m.approved, registered: p.registered };
}

interface Tracked { kind: "swap" | "limit"; batch: number; postHash: string; postBlock: number; bytes: number; buy: boolean; amountIn: string; minOut: string; expiry?: string; at: number }
const TRACK_KEY = "blind.orders.v1";
const loadTracked = (): Tracked[] => { try { return JSON.parse(localStorage.getItem(TRACK_KEY) ?? "[]"); } catch { return []; } };
const saveTracked = (t: Tracked[]) => { try { localStorage.setItem(TRACK_KEY, JSON.stringify(t.slice(0, 12))); } catch { /* blocked */ } };

export default function Trade() {
  const { s, down } = useLive();
  const now = useNow(500);
  const [acc, setAcc] = useState<UnifiedAccount | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [setup, setSetup] = useState<Setup>({ keys: "todo", fund: "todo", key: "todo", window: "todo", approve: "todo" });
  const [setupMsg, setSetupMsg] = useState<string>("");
  const [setupErr, setSetupErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [hashes, setHashes] = useState<{ k: string; h: string }[]>([]);
  const [tracked, setTracked] = useState<Tracked[]>(loadTracked);
  const [tab, setTab] = useState<"swap" | "limit">("swap");
  const [restoring, setRestoring] = useState(() => !!storedWords());

  const refreshMe = useCallback(async (a = acc) => {
    if (!a) return null;
    try { const m = await readMe(a); setMe(m); return m; } catch { return null; }
  }, [acc]);

  // Restore a saved test account and work out which setup steps are already done.
  useEffect(() => {
    (async () => {
      if (!storedWords()) return;
      try {
        const a = await loadAccount();
        if (!a) return;
        setAcc(a);
        const m = await refreshMe(a);
        if (m) setSetup(stepsFrom(m));
      } finally { setRestoring(false); }
    })();
  }, []);
  useEffect(() => {
    if (!acc) return;
    const t = setInterval(() => refreshMe(), 8000);
    const vis = () => document.visibilityState === "visible" && refreshMe();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [acc, refreshMe]);

  const ready = setup.approve === "done" && setup.key === "done";

  async function runSetup() {
    if (busy) return;
    setBusy(true); setSetupErr("");
    const mark = (k: keyof Setup, v: StepState) => setSetup((x) => ({ ...x, [k]: v }));
    let cur: keyof Setup = "keys";
    try {
      let a = acc;
      if (!a) { mark("keys", "run"); setSetupMsg("Making your keys in this browser."); a = await newAccount(); setAcc(a); }
      mark("keys", "done");
      let m = await readMe(a);
      setMe(m);
      cur = "fund";
      if (m.qor === 0n && m.fUSD === 0n) {
        mark("fund", "run"); setSetupMsg("Asking the faucet for test funds.");
        const f = await fund(a);
        setHashes((h) => [...h, { k: "Funds", h: f.hash }]);
        m = await readMe(a); setMe(m);
      }
      mark("fund", "done");
      cur = "key";
      if (!m.registered) {
        mark("key", "run"); setSetupMsg("Registering your post quantum key on QoreChain.");
        const r = await registerKey(a);
        if (r) setHashes((h) => [...h, { k: "Key registered", h: r.hash }]);
      }
      mark("key", "done");
      cur = "window";
      if (!(m.approved.fUSD && m.approved.fETH)) {
        const st = s ?? (await api.state());
        mark("window", "run"); setSetupMsg("Opening a short EVM window for two approvals.");
        const w = await openWindow(a, [st.tokens.fUSD.address, st.tokens.fETH.address]);
        setHashes((h) => [...h, { k: "Window", h: w.hash }]);
        mark("window", "done");
        cur = "approve";
        mark("approve", "run"); setSetupMsg("Approving the Blind contract for fUSD and fETH.");
        const ap = await approveBoth(a, st);
        setHashes((h) => [...h, ...ap.map((x, i) => ({ k: `Approval ${i + 1}`, h: x }))]);
      }
      mark("window", "done"); mark("approve", "done");
      setSetupMsg("Your test account is ready. Place a sealed swap.");
      await refreshMe(a);
    } catch (e: any) {
      mark(cur, "err");
      setSetupErr(e?.message ?? "Something failed. Try again.");
      setSetupMsg("");
    } finally { setBusy(false); }
  }

  function addTracked(t: Tracked) {
    setTracked((xs) => { const n = [t, ...xs]; saveTracked(n); return n; });
  }

  return (
    <div className="page wrap">
      <div className="apphead">
        <h1>Sealed swap</h1>
        <p className="mute" style={{ margin: 0, maxWidth: 440 }}>fUSD and fETH on QoreChain testnet. Your order is sealed here, in this browser, before it is sent.</p>
      </div>
      <BatchBar s={s} down={down} now={now} />
      <div className="appgrid">
        <div className="col">
          <AccountPanel restoring={restoring} acc={acc} me={me} setup={setup} busy={busy} msg={setupMsg} err={setupErr} hashes={hashes}
            onRun={runSetup} onRefresh={() => refreshMe()}
            onReset={() => { forgetAccount(); setAcc(null); setMe(null); setHashes([]); setSetup({ keys: "todo", fund: "todo", key: "todo", window: "todo", approve: "todo" }); setTracked([]); saveTracked([]); }} />
        </div>
        <div className="col">
          <div className="tabs" role="tablist">
            <button role="tab" className={tab === "swap" ? "on" : ""} onClick={() => setTab("swap")}>Swap in the next batch</button>
            <button role="tab" className={tab === "limit" ? "on" : ""} onClick={() => setTab("limit")}>Limit order</button>
          </div>
          {tab === "swap"
            ? <SwapBox s={s} acc={acc} me={me} ready={ready} onPlaced={(t) => { addTracked(t); refreshMe(); }} />
            : <LimitBox s={s} acc={acc} me={me} ready={ready} onPlaced={(t) => { addTracked(t); refreshMe(); }} />}
          <Orders tracked={tracked} acc={acc} s={s} now={now} onSettled={() => refreshMe()} />
        </div>
      </div>
    </div>
  );
}

function stepsFrom(m: Me): Setup {
  const funded = m.qor > 0n || m.fUSD > 0n;
  const approved = m.approved.fUSD && m.approved.fETH;
  return { keys: "done", fund: funded ? "done" : "todo", key: m.registered ? "done" : "todo", window: approved ? "done" : "todo", approve: approved ? "done" : "todo" };
}

// ------------------------------------------------------------------ the batch bar
function BatchBar({ s, down, now }: { s: State | null; down: boolean; now: number }) {
  const step = s ? phaseStep(s.phase) : -1;
  const left = s?.phase === "intake" && s.batch.closesAt ? Math.max(0, Math.ceil((s.batch.closesAt - now) / 1000)) : null;
  return (
    <div className="batchbar">
      <div>
        <div className="id">{s ? `Batch ${s.batch.id}` : "Batch"}</div>
        <div className="small mute" style={{ maxWidth: 260 }}>{down ? "The server is not answering. Retrying." : s ? phaseLine(s, now) : "Reading the chain."}</div>
      </div>
      <div className="bsteps" aria-label="Batch steps">
        {STEPS.map((n, i) => <div key={n} className={i < step ? "done" : i === step ? "on" : ""}><i />{n}</div>)}
      </div>
      <div className="cd" title="Seconds until intake closes">{left !== null ? `0:${String(left).padStart(2, "0")}` : s?.phase === "waiting" ? "open" : "closed"}</div>
    </div>
  );
}

// ------------------------------------------------------------------ account
function AccountPanel(p: { restoring: boolean; acc: UnifiedAccount | null; me: Me | null; setup: Setup; busy: boolean; msg: string; err: string; hashes: { k: string; h: string }[]; onRun: () => void; onRefresh: () => void; onReset: () => void }) {
  const [words, setWords] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const allDone = Object.values(p.setup).every((x) => x === "done");
  if (p.restoring) return <div><div className="colh"><span>Your test account</span></div><div className="msg">Loading the test account saved in this browser.</div></div>;
  return (
    <div>
      <div className="colh"><span>Your test account</span>{p.acc && <button className="linkbtn" onClick={p.onRefresh}>Refresh</button>}</div>
      {p.acc && (
        <>
          <div className="addr">{short(p.acc.evm, 8, 6)} <Copy text={p.acc.evm} /></div>
          <div className="bal">
            <div><div className="v">{p.me ? usd(p.me.fUSD) : "…"}</div><div className="k">fUSD</div></div>
            <div><div className="v">{p.me ? eth(p.me.fETH, 5) : "…"}</div><div className="k">fETH</div></div>
            <div><div className="v">{p.me ? (Number(p.me.qor) / 1e6).toFixed(3) : "…"}</div><div className="k">QOR for fees</div></div>
          </div>
        </>
      )}
      {!allDone && (
        <ul className="checks">
          {(Object.keys(SETUP_TEXT) as (keyof Setup)[]).map((k) => (
            <li key={k} className={p.setup[k] === "done" ? "done" : p.setup[k] === "run" ? "run" : p.setup[k] === "err" ? "err" : ""}>
              <span className="m" />
              <span>{SETUP_TEXT[k][0]}<small>{SETUP_TEXT[k][1]}</small></span>
            </li>
          ))}
        </ul>
      )}
      {!allDone && (
        <button className="btn wax go" style={{ marginTop: 4 }} onClick={p.onRun} disabled={p.busy}>
          {p.busy ? "Working…" : p.acc ? (p.err ? "Try again" : "Finish setting up") : "Get a test account"}
        </button>
      )}
      {!p.acc && !p.busy && <p className="small mute">No wallet, no sign up. Takes about 30 seconds. The faucet gives each browser one test account a day.</p>}
      {p.msg && <div className="msg">{p.msg}</div>}
      {p.err && <div className="msg err">{p.err}</div>}
      {p.hashes.length > 0 && (
        <details className="raw"><summary>Transactions</summary><div className="rows">{p.hashes.map((x) => <div key={x.h}>{x.k}: <TxLink h={x.h} /></div>)}</div></details>
      )}
      {p.acc && (
        <div style={{ marginTop: 22, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <button className="linkbtn" onClick={() => setWords((x) => !x)}>{words ? "Hide recovery words" : "Show recovery words"}</button>
          {!confirmReset ? <button className="linkbtn" onClick={() => setConfirmReset(true)}>Start over</button>
            : <button className="linkbtn" style={{ color: "var(--wax)" }} onClick={() => { setConfirmReset(false); p.onReset(); }}>Delete this test account from the browser</button>}
        </div>
      )}
      {words && p.acc && (
        <div>
          <div className="words">{storedWords() ?? "Not saved in this browser."}</div>
          <p className="small mute">A test account in this browser only. Anyone with these words controls it. Test tokens have no value.</p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ swap
const toUnits = (v: string, dec: number) => {
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return 0n;
  const [a, b = ""] = v.split(".");
  return BigInt(a || "0") * 10n ** BigInt(dec) + BigInt((b + "0".repeat(dec)).slice(0, dec) || "0");
};

function useQuote(side: "buy" | "sell", amount: bigint) {
  const [q, setQ] = useState<Quote | null>(null);
  useEffect(() => {
    if (amount <= 0n) { setQ(null); return; }
    let on = true;
    const t = setTimeout(() => api.quote(side, amount).then((x) => on && setQ(x)).catch(() => on && setQ(null)), 350);
    const r = setInterval(() => api.quote(side, amount).then((x) => on && setQ(x)).catch(() => undefined), 10000);
    return () => { on = false; clearTimeout(t); clearInterval(r); };
  }, [side, amount]);
  return q;
}

function OrderForm(p: { s: State | null; me: Me | null; buy: boolean; setBuy: (b: boolean) => void; amt: string; setAmt: (v: string) => void; bps: number; setBps: (n: number) => void }) {
  const unit = p.buy ? "fUSD" : "fETH";
  const presets = p.buy ? ["2", "5", "10"] : ["0.001", "0.002", "0.004"];
  const bal = p.me ? (p.buy ? usd(p.me.fUSD) : eth(p.me.fETH, 5)) : null;
  return (
    <>
      <div className="seg" role="radiogroup" aria-label="Side">
        <button className={p.buy ? "on" : ""} onClick={() => { p.setBuy(true); p.setAmt("5"); }}>Buy fETH</button>
        <button className={!p.buy ? "on" : ""} onClick={() => { p.setBuy(false); p.setAmt("0.002"); }}>Sell fETH</button>
      </div>
      <div className="field">
        <label><span>You pay</span>{bal !== null && <span>Balance {bal} {unit}</span>}</label>
        <div className="amt"><input inputMode="decimal" value={p.amt} onChange={(e) => p.setAmt(e.target.value.replace(",", "."))} aria-label={`Amount in ${unit}`} /><span className="u">{unit}</span></div>
        <div className="chips" style={{ marginTop: 10 }}>{presets.map((x) => <button key={x} className={p.amt === x ? "on" : ""} onClick={() => p.setAmt(x)}>{x}</button>)}</div>
      </div>
      <div className="field">
        <label><span>Your limit, away from the pool price</span><span className="mono">{(p.bps / 100).toFixed(1)}%</span></label>
        <input type="range" min={50} max={1000} step={50} value={p.bps} onChange={(e) => p.setBps(Number(e.target.value))} aria-label="Limit in percent" />
        <div className="small mute">If the batch price is worse than this, your order is left out and nothing moves.</div>
      </div>
    </>
  );
}

function SwapBox({ s, acc, me, ready, onPlaced }: { s: State | null; acc: UnifiedAccount | null; me: Me | null; ready: boolean; onPlaced: (t: Tracked) => void }) {
  const [buy, setBuy] = useState(true);
  const [amt, setAmt] = useState("5");
  const [bps, setBps] = useState(400);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [sealed, setSealed] = useState<Built | null>(null);
  const amount = useMemo(() => toUnits(amt, buy ? 6 : 18), [amt, buy]);
  const q = useQuote(buy ? "buy" : "sell", amount);
  const bal = me ? (buy ? me.fUSD : me.fETH) : 0n;
  const minOut = s && amount > 0n ? minOutFor(buy, amount, BigInt(s.pool.mid), BigInt(bps)) : null;
  const outFmt = (v: string | bigint) => (buy ? `${eth(v)} fETH` : `${usd(v)} fUSD`);
  const amm = q?.plainAmm ? BigInt(q.plainAmm) : null;
  const alone = q ? BigInt(q.blindIfAlone) : null;
  const block = !acc ? "Get a test account first" : !ready ? "Finish setting up your account" : amount <= 0n ? "Enter an amount" : amount > bal ? `Not enough ${buy ? "fUSD" : "fETH"}` : q && !q.withinMakerSize ? "Too large for one batch. Try a smaller amount" : "";

  async function go() {
    if (!acc || block) return;
    setErr(""); setSealed(null); setBusy("Signing and sealing in your browser.");
    try {
      const r = await placeSwap(acc, { buy, amountIn: amount, bps: BigInt(bps) }, (b) => { setSealed(b); setBusy("Sealed. Posting the envelope on chain."); });
      onPlaced({ kind: "swap", batch: r.batch, postHash: r.hash, postBlock: r.block, bytes: r.built.bytes, buy, amountIn: amount.toString(), minOut: r.built.order.minOut.toString(), at: Date.now() });
      setBusy("");
      refreshState();
    } catch (e: any) { setErr(e?.message ?? "The order was not placed."); setBusy(""); }
  }

  return (
    <div>
      <OrderForm s={s} me={me} buy={buy} setBuy={setBuy} amt={amt} setAmt={setAmt} bps={bps} setBps={setBps} />
      <div className="compare">
        <div className="r"><span>Blind, if nobody trades the other side</span><span className="mono">{alone !== null ? outFmt(alone) : "…"}</span></div>
        <div className="r"><span>x/amm right now, same input</span><span className="mono">{q ? (q.ammRefused ? "refuses this size" : amm !== null ? outFmt(amm) : "…") : "…"}</span></div>
        <div className="r"><span>The least you accept</span><span className="mono">{minOut !== null ? outFmt(minOut) : "…"}</span></div>
        <div className="why">Trading alone costs about x/amm plus 0.15%. If someone takes the other side in your batch, you both do better than x/amm.</div>
      </div>
      <button className="btn wax go" onClick={go} disabled={!!block || !!busy}>{busy ? "Sealing…" : block || "Seal and send"}</button>
      {busy && <div className="msg">{busy}</div>}
      {sealed && busy && <div className="msg mono small">{sealed.bytes.toLocaleString("en-US")} bytes of ML-KEM-1024 ciphertext, signed with ML-DSA-87.</div>}
      {err && <div className="msg err">{err}</div>}
    </div>
  );
}

function LimitBox({ s, acc, me, ready, onPlaced }: { s: State | null; acc: UnifiedAccount | null; me: Me | null; ready: boolean; onPlaced: (t: Tracked) => void }) {
  const [buy, setBuy] = useState(true);
  const [amt, setAmt] = useState("5");
  const [bps, setBps] = useState(100);
  const [hours, setHours] = useState(1);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const amount = useMemo(() => toUnits(amt, buy ? 6 : 18), [amt, buy]);
  const bal = me ? (buy ? me.fUSD : me.fETH) : 0n;
  const minOut = s && amount > 0n ? minOutFor(buy, amount, BigInt(s.pool.mid), BigInt(bps)) : null;
  const outFmt = (v: bigint) => (buy ? `${eth(v)} fETH` : `${usd(v)} fUSD`);
  const block = !acc ? "Get a test account first" : !ready ? "Finish setting up your account" : amount <= 0n ? "Enter an amount" : amount > bal ? `Not enough ${buy ? "fUSD" : "fETH"}` : "";
  async function go() {
    if (!acc || block) return;
    setErr(""); setBusy("Signing and sealing to the standing key.");
    try {
      const blocks = BigInt(hours * 2700);
      const head = await pub.getBlockNumber();
      const r = await placeLimit(acc, { buy, amountIn: amount, bps: BigInt(bps), blocks }, () => setBusy("Sealed. Posting on chain."));
      onPlaced({ kind: "limit", batch: r.batch, postHash: r.hash, postBlock: r.block, bytes: r.built.bytes, buy, amountIn: amount.toString(), minOut: r.built.order.minOut.toString(), expiry: (head + blocks).toString(), at: Date.now() });
      setBusy("");
      refreshState();
    } catch (e: any) { setErr(e?.message ?? "The order was not placed."); setBusy(""); }
  }
  return (
    <div>
      <p className="small" style={{ marginTop: 0, color: "var(--ink2)" }}>A limit order waits and is checked in every batch until it fills or expires. It is sealed to a standing key that the operator can read, so it is not hidden from the operator the way a swap is.</p>
      <OrderForm s={s} me={me} buy={buy} setBuy={setBuy} amt={amt} setAmt={setAmt} bps={bps} setBps={setBps} />
      <div className="field">
        <label><span>Wait for up to</span></label>
        <div className="chips">{[1, 6, 24].map((h) => <button key={h} className={hours === h ? "on" : ""} onClick={() => setHours(h)}>{h} h</button>)}</div>
      </div>
      <div className="compare">
        <div className="r"><span>Fills only at or better than</span><span className="mono">{minOut !== null ? outFmt(minOut) : "…"}</span></div>
        <div className="r"><span>Expires after</span><span className="mono">{(hours * 2700).toLocaleString("en-US")} blocks</span></div>
        <div className="r"><span>Limit orders waiting now</span><span className="mono">{s ? s.standingOpen : "…"}</span></div>
      </div>
      <button className="btn wax go" onClick={go} disabled={!!block || !!busy}>{busy ? "Sealing…" : block || "Seal and place limit order"}</button>
      {busy && <div className="msg">{busy}</div>}
      {err && <div className="msg err">{err}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ your orders
function Orders({ tracked, acc, s, now, onSettled }: { tracked: Tracked[]; acc: UnifiedAccount | null; s: State | null; now: number; onSettled: () => void }) {
  if (!acc || !tracked.length) return null;
  return (
    <div style={{ marginTop: 40 }}>
      <div className="colh"><span>Your orders</span></div>
      {tracked.map((t) => <OrderTrack key={t.postHash} t={t} acc={acc} s={s} now={now} onSettled={onSettled} />)}
    </div>
  );
}

function OrderTrack({ t, acc, s, onSettled }: { t: Tracked; acc: UnifiedAccount; s: State | null; now: number; onSettled: () => void }) {
  const [rec, setRec] = useState<BatchRec | null>(null);
  const [limitFill, setLimitFill] = useState<{ rec: BatchRec; i: number } | null>(null);
  const me = acc.evm.toLowerCase();
  useEffect(() => {
    let on = true;
    const go = async () => {
      if (t.kind === "swap") {
        if (rec) return;
        const b = await api.batches().catch(() => null);
        const r = b?.live.find((x) => x.batch === t.batch) ?? null;
        if (r && on) { setRec(r); onSettled(); }
      } else {
        if (limitFill) return;
        const b = await api.batches().catch(() => null);
        for (const r of b?.live ?? []) {
          const i = (r.fills ?? []).findIndex((f) => f.standing && f.user.toLowerCase() === me && f.amountIn === t.amountIn);
          if (i >= 0 && on) { setLimitFill({ rec: r, i }); onSettled(); break; }
        }
      }
    };
    go();
    const x = setInterval(go, 3000);
    return () => { on = false; clearInterval(x); };
  }, [t.postHash, rec, limitFill]);

  const sideLine = `${t.buy ? "Buy fETH with" : "Sell"} ${t.buy ? `${usd(t.amountIn)} fUSD` : `${eth(t.amountIn)} fETH`}`;

  if (t.kind === "limit") {
    const r = limitFill?.rec, f = r?.fills?.[limitFill!.i];
    return (
      <div className="track">
        <div className="it done"><span className="st">Limit</span><span><Seal open={!!f}>{sideLine}</Seal></span><TxLink h={t.postHash} label="posted" /></div>
        {!f && <div className="it on"><span className="st">Waiting</span><span>Checked in every batch until block {blockNo(Number(t.expiry))}.</span><span /></div>}
        {f && r && <Result f={f} rec={r} />}
      </div>
    );
  }

  const step = rec ? 5 : s && s.batch.id === t.batch ? phaseStep(s.phase) : s && s.batch.id > t.batch ? 5 : 1;
  const mine = rec?.fills?.findIndex((f) => f.user.toLowerCase() === me && f.amountIn === t.amountIn && !f.standing) ?? -1;
  const dropped = rec?.dropped?.find((d) => d.user.toLowerCase() === me);
  const items: { st: string; text: string; h?: string; on: boolean; done: boolean }[] = [
    { st: "Sealed", text: `${t.bytes.toLocaleString("en-US")} bytes, signed in this browser`, on: false, done: true },
    { st: "Posted", text: `Batch ${t.batch}, block ${blockNo(t.postBlock)}`, h: t.postHash, on: false, done: true },
    { st: "Committed", text: rec?.commit ? `Market maker price fixed in block ${blockNo(rec.commit.block)}` : "Market maker commits its price after intake closes", h: rec?.commit?.hash, on: step === 2 || step === 1, done: step > 2 },
    { st: "Revealed", text: rec?.open ? `Batch key revealed in block ${blockNo(rec.open.block)}` : "The batch key is revealed in a later block", h: rec?.open?.hash, on: step === 3, done: step > 3 },
    { st: "Settled", text: rec?.settle ? `One price for everyone, block ${blockNo(rec.settle.block)}` : rec ? "This batch did not settle" : "One transaction settles the batch", h: rec?.settle?.hash, on: step === 4, done: !!rec?.settle },
  ];
  return (
    <div className="track">
      <div className="it done"><span className="st">Order</span><span><Seal open={!!rec}>{sideLine}</Seal></span><span /></div>
      {items.map((x) => (
        <div key={x.st} className={`it ${x.done ? "done" : x.on ? "on" : ""}`}><span className="st">{x.st}</span><span>{x.text}</span>{x.h ? <TxLink h={x.h} label="view" /> : <span />}</div>
      ))}
      {rec && mine >= 0 && <Result f={rec.fills![mine]} rec={rec} />}
      {rec && mine < 0 && (
        <div className="result"><div className="big">Not filled</div><div className="vs">{dropped ? `Left out: ${dropped.reason}. Nothing moved from your account.` : rec.error ? "The batch stopped before settling. Nothing moved from your account." : "Your order was not in this settlement. Nothing moved from your account."}</div></div>
      )}
    </div>
  );
}

function Result({ f, rec }: { f: NonNullable<BatchRec["fills"]>[number]; rec: BatchRec }) {
  const e = edgeBps(f);
  const out = f.buy ? `${eth(f.amountOut, 6)} fETH` : `${usd(f.amountOut)} fUSD`;
  const amm = f.buy ? `${eth(f.plainAmm, 6)} fETH` : `${usd(f.plainAmm)} fUSD`;
  return (
    <div className="result">
      <div className="small mute" style={{ textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>You received</div>
      <div className="big">{out}</div>
      <div className="vs">
        {e === null ? "x/amm would have refused this size (over its 5% impact cap)."
          : <>x/amm would have paid {amm} for the same input. <b style={{ color: "var(--ink)" }}>{e >= 0 ? `${pct(e)} better` : `${pct(e)} worse`}</b> with Blind.</>}
      </div>
      <div className="small mute" style={{ marginTop: 8 }}>Batch price {(Number(rec.settle!.price) / 1e6).toFixed(2)} fUSD per fETH. <Link to={`/batch/${rec.batch}`}>See the whole batch</Link></div>
    </div>
  );
}
