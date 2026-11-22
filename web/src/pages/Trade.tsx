import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UnifiedAccount } from "@qorechain/sdk";
import { api, batchPath, type Attempt, type BatchRec, type BotStats, type Quote, type State } from "../lib/api";
import {
  loadAccount, newAccount, forgetAccount, storedWords, fund, registerKey, openWindow, approveBoth,
  placeSwap, placeLimit, minOutFor, pub, publicSwap, publicSwapResult, bankDenom, type Built,
} from "../lib/chain";
import { usd, eth, short, blockNo, pct, edgeBps } from "../lib/fmt";
import { useLive, useNow, phaseStep, phaseLine, phaseBlind, STEPS, TxLink, Copy, Link, refreshState, usePoll, latestSettled, Qc, StepQc } from "../ui";
import { txUrl, STEP_TECH, viaLinkedKey, COMMIT_PLAIN } from "../lib/qore";
import Blind from "../Blind";
import BatchPanel from "../BatchPanel";

type StepState = "todo" | "run" | "done" | "err";
interface Setup { keys: StepState; fund: StepState; key: StepState; window: StepState; approve: StepState }
const SETUP_TEXT: Record<keyof Setup, [string, string]> = {
  keys: ["Make a test account", "Keys are created in this browser, including your post quantum key."],
  fund: ["Get test funds", "15 fUSD and 0.005 fETH for sealed swaps, 6 fUSD and 0.002 fETH for a public swap, and QOR for fees, from the Blind faucet."],
  key: ["Register your post quantum key", "QoreChain records your signing key so the contract can check your orders."],
  window: ["Open a short EVM window", "Allows two token approvals, to fUSD and fETH only."],
  approve: ["Approve the Blind contract", "Lets settlement move the tokens you sell. Two transactions."],
};

interface Me { fUSD: bigint; fETH: bigint; qor: bigint; bank: { fUSD: bigint; fETH: bigint }; approved: { fUSD: boolean; fETH: boolean }; registered: boolean }

let tokensP: Promise<State["tokens"]> | null = null;
const tokens = () => (tokensP ??= api.state().then((x) => x.tokens).catch((e) => { tokensP = null; throw e; }));

async function readMe(acc: UnifiedAccount): Promise<Me> {
  const [m, p, b, tk] = await Promise.all([
    api.me(acc.evm),
    api.pqc(acc.cosmos).catch(() => ({ registered: false })),
    fetch(`/api/rest/cosmos/bank/v1beta1/balances/${acc.cosmos}`).then((r) => r.json()).catch(() => ({ balances: [] })),
    tokens(),
  ]);
  const of = (d: string) => BigInt((b.balances ?? []).find((x: any) => x.denom.toLowerCase() === d.toLowerCase())?.amount ?? "0");
  return {
    fUSD: BigInt(m.fUSD), fETH: BigInt(m.fETH), qor: of("uqor"), approved: m.approved, registered: p.registered,
    bank: { fUSD: of(bankDenom(tk.fUSD.address)), fETH: of(bankDenom(tk.fETH.address)) },
  };
}

interface Tracked { kind: "swap" | "limit"; batch: number; postHash: string; postBlock: number; bytes: number; buy: boolean; amountIn: string; minOut: string; expiry?: string; at: number; duel?: string }
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
  const [tab, setTab] = useState<"both" | "swap" | "limit">("both");
  const [duel, setDuel] = useState<Duel | null>(loadDuel);
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
      setSetupMsg("Your test account is ready. Send a swap both ways.");
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
  const placed = (t: Tracked) => { addTracked(t); refreshMe(); };

  return (
    <div className="page wrap">
      <div className="apphead">
        <h1>Sealed swap</h1>
        <p>fUSD and fETH on QoreChain testnet. Your order is sealed here, in this browser, before it is sent.</p>
      </div>
      <div className="tradegrid">
        <div className="tradeside">
          <BatchBar s={s} down={down} now={now} tracked={tracked} />
        </div>
        <div className="trademain">
          <AccountPanel restoring={restoring} acc={acc} me={me} setup={setup} busy={busy} msg={setupMsg} err={setupErr} hashes={hashes}
            onRun={runSetup} onRefresh={() => refreshMe()}
            onReset={() => { forgetAccount(); setAcc(null); setMe(null); setHashes([]); setSetup({ keys: "todo", fund: "todo", key: "todo", window: "todo", approve: "todo" }); setTracked([]); saveTracked([]); setDuel(null); saveDuel(null); }} />
          <div className={`stp ${ready ? "cur" : "later"}`}>
            <div className="stph"><span className="n">5</span><h3>Send a swap</h3></div>
            <div className="stpb">
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === "both"} className={tab === "both" ? "on" : ""} onClick={() => setTab("both")}>Both ways</button>
                <button role="tab" aria-selected={tab === "swap"} className={tab === "swap" ? "on" : ""} onClick={() => setTab("swap")}>Sealed only</button>
                <button role="tab" aria-selected={tab === "limit"} className={tab === "limit" ? "on" : ""} onClick={() => setTab("limit")}>Limit order</button>
              </div>
              {tab === "both"
                ? <BothBox s={s} acc={acc} me={me} ready={ready} onDuel={(d) => { setDuel(d); saveDuel(d); }} onPlaced={(t) => { addTracked(t); refreshMe(); }} />
                : tab === "swap"
                  ? <SwapBox s={s} acc={acc} me={me} ready={ready} onPlaced={placed} />
                  : <LimitBox s={s} acc={acc} me={me} ready={ready} onPlaced={placed} />}
            </div>
          </div>
          {acc && duel && <DuelView key={duel.id} d={duel} acc={acc} s={s} now={now} onSettled={() => refreshMe()} />}
          <Orders tracked={tracked.filter((t) => !t.duel)} acc={acc} s={s} now={now} onSettled={() => refreshMe()} />
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

// ------------------------------------------------------------------ the live batch, as a blind
function BatchBar({ s, down, now, tracked }: { s: State | null; down: boolean; now: number; tracked: Tracked[] }) {
  const step = s ? phaseStep(s.phase) : -1;
  const left = s?.phase === "intake" && s.batch.closesAt ? Math.max(0, Math.ceil((s.batch.closesAt - now) / 1000)) : null;
  const { v: b } = usePoll(api.batches, 6000);
  const state = s ? phaseBlind(s.phase) : "closed";
  const thisRec = s && b ? [...b.live, ...b.testRuns].find((r) => r.batch === s.batch.id && r.settled) ?? null : null;
  const shown = s?.phase === "hedging" ? thisRec : s?.phase === "waiting" ? latestSettled(b) : null;
  const mine = s ? tracked.filter((t) => t.kind === "swap" && t.batch === s.batch.id) : [];
  return (
    <div className="livebatch">
      <div className="lbh">
        <div>
          <div className="id">{s ? `Batch ${s.batch.id}` : "Batch"}</div>
          <div className="pl">{down ? "The server is not answering. Retrying." : s ? phaseLine(s, now) : "Reading the chain."}</div>
        </div>
        <div className="cd" title="Seconds until intake closes">{left !== null ? `0:${String(left).padStart(2, "0")}` : s?.phase === "waiting" ? "ready" : s ? "closed" : ""}</div>
      </div>
      <Blind state={state} label={s ? `Batch ${s.batch.id}, ${state}` : "Batch"}>
        {shown ? <BatchPanel rec={shown} max={3} /> : (
          <div className="bp">
            <div className="bp-h"><span>Batch {s?.batch.id ?? ""}</span><span>{s?.phase === "hedging" ? "recording the fills" : "opening from chain data"}</span></div>
            {mine.map((t) => <div className="bp-r" key={t.postHash}><span className="side">{t.buy ? "Buy" : "Sell"}</span><span className="what">Your order, {t.buy ? `${usd(t.amountIn)} fUSD` : `${eth(t.amountIn)} fETH`}</span><span /></div>)}
            {!mine.length && <div className="bp-r"><span className="what">Every order in this batch opens at the same moment.</span></div>}
          </div>
        )}
      </Blind>
      <ol className="strip" aria-label="Batch steps">
        {STEPS.map((n, i) => <li key={n} className={i < step ? "done" : i === step ? "on" : ""}><span>{n}</span></li>)}
      </ol>
      <p className="cap">{state === "open"
        ? `${shown ? `In daylight: batch ${shown.batch}, settled${shown.live ? "" : " by our test traders"}. ` : ""}The blind closes when the next batch takes orders.`
        : state === "opening" ? "The price is locked on chain. The blind is opening." : "Closed. Orders in this batch stay sealed until the price is locked."}</p>
      {s && (step === 5
        ? <Qc name="x/amm pool 3">the agent rebalances from a separate account, hybrid signed</Qc>
        : <StepQc i={Math.max(0, step)} />)}
    </div>
  );
}

// ------------------------------------------------------------------ account, as a guided stepper
const GUIDE: { k: (keyof Setup)[]; t: string; d: string; q: [string, string]; tx: string[] }[] = [
  { k: ["keys"], t: SETUP_TEXT.keys[0], d: SETUP_TEXT.keys[1], q: ["@qorechain/sdk", "a secp256k1 key and an ML-DSA-87 key, both made in this browser"], tx: [] },
  { k: ["fund"], t: SETUP_TEXT.fund[0], d: SETUP_TEXT.fund[1], q: ["Faucet tokens", "the relayer converts bank coins to ERC-20 with MsgConvertCoin"], tx: ["Funds"] },
  { k: ["key"], t: SETUP_TEXT.key[0], d: SETUP_TEXT.key[1], q: ["MsgRegisterPQCKeyV2", "your ML-DSA-87 key, with proof of possession. After this every transaction is hybrid signed, and QoreSign checks both halves before the relayer broadcasts"], tx: ["Key registered"] },
  { k: ["window", "approve"], t: SETUP_TEXT.approve[0], d: "Lets settlement move the tokens you sell, fUSD and fETH only. A short window allows the two approvals.", q: ["Scoped EVM window", "2 transactions within 600 blocks, to fUSD and fETH only, then the two approvals on QoreChain EVM"], tx: ["Window", "Approval 1"] },
];
function stOf(setup: Setup, ks: (keyof Setup)[]): StepState {
  const v = ks.map((k) => setup[k]);
  if (v.includes("err")) return "err";
  if (v.includes("run")) return "run";
  if (v.every((x) => x === "done")) return "done";
  return "todo";
}

function AccountPanel(p: { restoring: boolean; acc: UnifiedAccount | null; me: Me | null; setup: Setup; busy: boolean; msg: string; err: string; hashes: { k: string; h: string }[]; onRun: () => void; onRefresh: () => void; onReset: () => void }) {
  const [words, setWords] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const allDone = Object.values(p.setup).every((x) => x === "done");
  if (p.restoring) return <div className="guide"><div className="stp cur"><div className="stph"><span className="n">1</span><h3>Your test account</h3></div><div className="stpb"><div className="msg">Loading the test account saved in this browser.</div></div></div></div>;
  const states = GUIDE.map((g) => stOf(p.setup, g.k));
  const cur = states.findIndex((x) => x !== "done");
  return (
    <div className="guide">
      {GUIDE.map((g, i) => (
        <div key={g.t} className={`stp ${states[i]} ${i === cur ? "cur" : ""}`}>
          <div className="stph"><span className="n">{states[i] === "done" ? "✓" : i + 1}</span><h3>{g.t}</h3></div>
          {(() => {
            const h = g.tx.map((k) => p.hashes.find((x) => x.k === k)?.h).find(Boolean);
            return <Qc name={g.q[0]} className="ind" href={h ? txUrl(h) : undefined} link={h ? "your transaction" : undefined}>{g.q[1]}</Qc>;
          })()}
          {i === cur && (
            <div className="stpb">
              <p>{g.d}</p>
              <button className="btn day" onClick={p.onRun} disabled={p.busy}>
                {p.busy ? "Working…" : p.acc ? (p.err ? "Try again" : "Finish setting up") : "Get a test account"}
              </button>
              {!p.acc && !p.busy && <p className="dim small">No wallet, no sign up. One button runs steps 1 to 4 in about 30 seconds. The faucet gives each network one test account a day.</p>}
              {p.msg && <div className="msg">{p.msg}</div>}
              {p.err && <div className="msg err">{p.err}</div>}
            </div>
          )}
        </div>
      ))}
      {allDone && p.msg && <div className="msg">{p.msg}</div>}
      {p.acc && (
        <div className="acct">
          <div className="acctrow">
            <span className="dim">Test account in this browser</span>
            <span className="mono">{short(p.acc.evm, 8, 6)} <Copy text={p.acc.evm} /></span>
          </div>
          <div className="bal">
            <div><b>{p.me ? usd(p.me.fUSD) : "…"}</b><span>fUSD</span></div>
            <div><b>{p.me ? eth(p.me.fETH, 5) : "…"}</b><span>fETH</span></div>
            <div><b>{p.me ? (Number(p.me.qor) / 1e6).toFixed(3) : "…"}</b><span>QOR for fees</span></div>
          </div>
          <div className="acctlinks">
            <button className="linkbtn" onClick={p.onRefresh}>Refresh</button>
            <button className="linkbtn" onClick={() => setWords((x) => !x)}>{words ? "Hide recovery words" : "Show recovery words"}</button>
            {!confirmReset ? <button className="linkbtn" onClick={() => setConfirmReset(true)}>Start over</button>
              : <button className="linkbtn warn" onClick={() => { setConfirmReset(false); p.onReset(); }}>Delete this test account from the browser</button>}
          </div>
          {words && (
            <div>
              <div className="words">{storedWords() ?? "Not saved in this browser."}</div>
              <p className="small dim">A test account in this browser only. Anyone with these words controls it. Test tokens have no value.</p>
            </div>
          )}
          {p.hashes.length > 0 && (
            <details className="raw"><summary>Setup transactions</summary><div className="rawrows">{p.hashes.map((x) => <div key={x.h}><span>{x.k}</span><TxLink h={x.h} /></div>)}</div></details>
          )}
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
        <div className="chips">{presets.map((x) => <button key={x} className={p.amt === x ? "on" : ""} onClick={() => p.setAmt(x)}>{x}</button>)}</div>
      </div>
      <div className="field">
        <label><span>Your limit, away from the pool price</span><span className="mono">{(p.bps / 100).toFixed(1)}%</span></label>
        <input type="range" min={50} max={1000} step={50} value={p.bps} onChange={(e) => p.setBps(Number(e.target.value))} aria-label="Limit in percent" />
        <div className="small dim">If the batch price is worse than this, your order is left out and nothing moves.</div>
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
      const r = await placeSwap(acc, { buy, amountIn: amount, bps: BigInt(bps) }, (b) => { setSealed(b); setBusy("Sealed. Posting it on chain."); });
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
      <button className="btn day go" onClick={go} disabled={!!block || !!busy}>{busy ? "Sealing…" : block || "Seal and send"}</button>
      {busy && <div className="msg">{busy}</div>}
      {sealed && busy && <div className="msg small">QoreSeal: {sealed.bytes.toLocaleString("en-US")} bytes sealed with ML-KEM-1024 + X25519, signed with your ML-DSA-87 key.</div>}
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
      <p className="note">A limit order waits and is checked in every batch until it fills or expires. It is sealed to a standing key that the operator can read, so it is not hidden from the operator the way a swap is.</p>
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
      <button className="btn day go" onClick={go} disabled={!!block || !!busy}>{busy ? "Sealing…" : block || "Seal and place limit order"}</button>
      {busy && <div className="msg">{busy}</div>}
      {err && <div className="msg err">{err}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ your orders
function Orders({ tracked, acc, s, now, onSettled }: { tracked: Tracked[]; acc: UnifiedAccount | null; s: State | null; now: number; onSettled: () => void }) {
  if (!acc || !tracked.length) return null;
  return (
    <div className="orders">
      <h3 className="colh">Your orders</h3>
      {tracked.map((t) => <OrderTrack key={t.postHash} t={t} acc={acc} s={s} now={now} onSettled={onSettled} />)}
    </div>
  );
}

function OrderTrack({ t, acc, s, onSettled, onRec, lane }: { t: Tracked; acc: UnifiedAccount; s: State | null; now: number; onSettled: () => void; onRec?: (r: BatchRec) => void; lane?: boolean }) {
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
        if (r && on) { setRec(r); onRec?.(r); onSettled(); }
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
        <div className="trackh"><b>{sideLine}</b><span className="dim">limit order</span></div>
        <Blind state={f ? "open" : "closed"} flat className="small">
          {f && r ? <Result f={f} rec={r} /> : <div className="res"><div className="k">Waiting</div><div className="vs">Checked in every batch until block {blockNo(Number(t.expiry))}.</div></div>}
        </Blind>
        <div className="it done"><span className="st">Posted</span><span>Sealed to the standing key, block {blockNo(t.postBlock)}</span><TxLink h={t.postHash} label="view" /><Qc name="QoreSeal and @qorechain/pqc">sealed in this browser; your ML-DSA-87 signature was checked on arrival</Qc></div>
        {!f && <div className="it on"><span className="st">Waiting</span><span>Checked in every batch until block {blockNo(Number(t.expiry))}.</span><span /></div>}
      </div>
    );
  }

  const step = rec ? 5 : s && s.batch.id === t.batch ? phaseStep(s.phase) : s && s.batch.id > t.batch ? 5 : 1;
  const mine = rec?.fills?.findIndex((f) => f.user.toLowerCase() === me && f.amountIn === t.amountIn && !f.standing) ?? -1;
  const dropped = rec?.dropped?.find((d) => d.user.toLowerCase() === me);
  const items: { st: string; text: string; h?: string; on: boolean; done: boolean; q?: ReactNode }[] = [
    { st: "Sealed", text: `${t.bytes.toLocaleString("en-US")} bytes, signed in this browser`, on: false, done: true, q: <StepQc i={0} /> },
    { st: "Posted", text: `Batch ${t.batch}, block ${blockNo(t.postBlock)}`, h: t.postHash, on: false, done: true, q: <StepQc i={1} /> },
    { st: "Price locked", text: rec?.commit ? `Market maker price locked in block ${blockNo(rec.commit.block)}` : "The market maker locks its price after intake closes", h: rec?.commit?.hash, on: step === 2 || step === 1, done: step > 2, q: rec?.commit && !viaLinkedKey(rec.commit.hash) ? <Qc name={COMMIT_PLAIN.name}>{COMMIT_PLAIN.rest}</Qc> : <StepQc i={2} href="/proof#agent" link="the rule" /> },
    { st: "Opened", text: rec?.open ? `Batch key revealed in block ${blockNo(rec.open.block)}` : "The batch key is revealed in a later block", h: rec?.open?.hash, on: step === 3, done: step > 3, q: <StepQc i={3} /> },
    { st: "Settled", text: rec?.settle ? `One price for everyone, block ${blockNo(rec.settle.block)}` : rec ? "This batch did not settle" : "One transaction settles the batch", h: rec?.settle?.hash, on: step === 4, done: !!rec?.settle, q: <StepQc i={4}>{rec?.settle && mine >= 0 ? "checked your ML-DSA-87 signature against the key pqcKeyStatus 0x0A02 reports" : undefined}</StepQc> },
  ];
  return (
    <div className="track">
      {!lane && <div className="trackh"><b>{sideLine}</b><span className="dim">batch {t.batch}</span></div>}
      <Blind state={rec ? "open" : step === 3 || step === 4 ? "opening" : "closed"} flat={!lane} className={lane ? "lane" : "small"} label={lane ? `Your sealed swap, batch ${t.batch}` : undefined}>
        {rec && mine >= 0 ? <Result f={rec.fills![mine]} rec={rec} lead={lane ? `The bot saw a sealed envelope: ${t.bytes.toLocaleString("en-US")} bytes, the same size as every other order, no side, no amount.` : undefined} />
          : rec ? <div className="res"><div className="big">Not filled</div><div className="vs">{dropped ? `Left out: ${dropped.reason}. Nothing moved from your account.` : rec.error ? "The batch stopped before settling. Nothing moved from your account." : "Your order was not in this settlement. Nothing moved from your account."}</div></div>
          : <div className="res"><div className="k">Sealed</div><div className="vs">Opens after the market maker's price is locked on chain.</div></div>}
      </Blind>
      {items.map((x) => (
        <div key={x.st} className={`it ${x.done ? "done" : x.on ? "on" : ""}`}><span className="st">{x.st}</span><span>{x.text}</span>{x.h ? <TxLink h={x.h} label="view" /> : <span />}{x.q}</div>
      ))}
    </div>
  );
}

function Result({ f, rec, lead }: { f: NonNullable<BatchRec["fills"]>[number]; rec: BatchRec; lead?: string }) {
  const e = edgeBps(f);
  const out = f.buy ? `${eth(f.amountOut, 6)} fETH` : `${usd(f.amountOut)} fUSD`;
  const amm = f.buy ? `${eth(f.plainAmm, 6)} fETH` : `${usd(f.plainAmm)} fUSD`;
  return (
    <div className="res">
      {lead && <p className="lead2">{lead}</p>}
      <div className="k">{lead ? "You got, at the batch price" : "You received"}</div>
      <div className="big">{out}</div>
      <div className="vs">
        {e === null ? "x/amm would have refused this size (over its 5% impact cap)."
          : <>x/amm would have paid {amm} for the same input. <b className={e >= 0 ? "pos" : "neg"}>{e >= 0 ? `${pct(e)} better` : `${pct(e)} worse`}</b> with Blind.</>}
      </div>
      <div className="foot2">Batch price {(Number(rec.settle!.price) / 1e6).toFixed(2)} fUSD per fETH. <TxLink h={rec.settle?.hash} label="Settlement" /> <Link to={batchPath(rec)}>See the whole batch</Link></div>
    </div>
  );
}

// ------------------------------------------------------------------ one swap, two lanes
interface Duel {
  id: string; at: number; buy: boolean; amountIn: string; slipBps: number; mid: string; quoteAmm: string; minOut: string;
  publicHash?: string; publicErr?: string; blind?: Tracked; blindErr?: string;
}
const DUEL_KEY = "blind.duel.v1";
function loadDuel(): Duel | null { try { return JSON.parse(localStorage.getItem(DUEL_KEY) ?? "null"); } catch { return null; } }
function saveDuel(d: Duel | null) { try { if (d) localStorage.setItem(DUEL_KEY, JSON.stringify(d)); else localStorage.removeItem(DUEL_KEY); } catch { /* blocked */ } }

const SLIPS = [100, 300, 500];

function BothBox({ s, acc, me, ready, onDuel, onPlaced }: { s: State | null; acc: UnifiedAccount | null; me: Me | null; ready: boolean; onDuel: (d: Duel) => void; onPlaced: (t: Tracked) => void }) {
  const [buy, setBuy] = useState(true);
  const [amt, setAmt] = useState("5");
  const [slip, setSlip] = useState(300);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const amount = useMemo(() => toUnits(amt, buy ? 6 : 18), [amt, buy]);
  const q = useQuote(buy ? "buy" : "sell", amount);
  const unit = buy ? "fUSD" : "fETH";
  const outFmt = (v: bigint) => (buy ? `${eth(v, 6)} fETH` : `${usd(v)} fUSD`);
  const amm = q?.plainAmm ? BigInt(q.plainAmm) : null;
  const least = amm !== null ? (amm * BigInt(10_000 - slip)) / 10_000n : null;
  const alone = q ? BigInt(q.blindIfAlone) : null;
  const pubBal = me ? (buy ? me.bank.fUSD : me.bank.fETH) : 0n;
  const sealBal = me ? (buy ? me.fUSD : me.fETH) : 0n;
  const noBank = !!me && me.bank.fUSD === 0n && me.bank.fETH === 0n;
  const block = !acc ? "Get a test account first" : !ready ? "Finish setting up your account"
    : noBank ? "No coins for the public swap on this account"
    : amount <= 0n ? "Enter an amount"
    : amount > pubBal ? `Not enough ${unit} for the public swap`
    : amount > sealBal ? `Not enough ${unit} for the sealed swap`
    : me && me.qor < 60_000n ? "Not enough QOR for the network fee"
    : q?.ammRefused ? "Too large for x/amm. Try a smaller amount"
    : q && !q.withinMakerSize ? "Too large for one batch. Try a smaller amount" : "";

  async function go() {
    if (!acc || block) return;
    setErr(""); setBusy("Getting the x/amm price.");
    try {
      const st = s ?? (await api.state());
      const fresh = await api.quote(buy ? "buy" : "sell", amount);
      if (!fresh.plainAmm) throw new Error("x/amm refuses this size. Try a smaller amount.");
      const minOut = (BigInt(fresh.plainAmm) * BigInt(10_000 - slip)) / 10_000n;
      const id = String(Date.now());
      let d: Duel = { id, at: Date.now(), buy, amountIn: amount.toString(), slipBps: slip, mid: st.pool.mid, quoteAmm: fresh.plainAmm, minOut: minOut.toString() };
      onDuel(d);
      setBusy("Sending both at once.");
      // Fire both lanes in the same tick.
      const pubP = publicSwap(acc, st, { buy, amountIn: amount, minOut })
        .then((h) => { d = { ...d, publicHash: h }; onDuel(d); })
        .catch((e) => { d = { ...d, publicErr: e?.message ?? "The public swap was not sent." }; onDuel(d); });
      const blindP = placeSwap(acc, { buy, amountIn: amount, bps: 400n })
        .then((r) => {
          const t: Tracked = { kind: "swap", batch: r.batch, postHash: r.hash, postBlock: r.block, bytes: r.built.bytes, buy, amountIn: amount.toString(), minOut: r.built.order.minOut.toString(), at: Date.now(), duel: id };
          onPlaced(t);
          d = { ...d, blind: t }; onDuel(d);
          refreshState();
        })
        .catch((e) => { d = { ...d, blindErr: e?.message ?? "The sealed swap was not placed." }; onDuel(d); });
      await Promise.all([pubP, blindP]);
      setBusy("");
    } catch (e: any) { setErr(e?.message ?? "Nothing was sent."); setBusy(""); }
  }

  return (
    <div>
      <p className="note">One swap, sent two ways at the same moment: a plain public swap on x/amm, and a sealed swap on Blind. A bot we run watches the public mempool.</p>
      <div className="seg" role="radiogroup" aria-label="Side">
        <button className={buy ? "on" : ""} onClick={() => { setBuy(true); setAmt("5"); }}>Buy fETH</button>
        <button className={!buy ? "on" : ""} onClick={() => { setBuy(false); setAmt("0.0015"); }}>Sell fETH</button>
      </div>
      <div className="field">
        <label><span>You pay, on each side</span>{me && <span>Public {buy ? usd(me.bank.fUSD) : eth(me.bank.fETH, 4)}, sealed {buy ? usd(me.fUSD) : eth(me.fETH, 4)} {unit}</span>}</label>
        <div className="amt"><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(",", "."))} aria-label={`Amount in ${unit}`} /><span className="u">{unit}</span></div>
        <div className="chips">{(buy ? ["2", "5"] : ["0.001", "0.0015"]).map((x) => <button key={x} className={amt === x ? "on" : ""} onClick={() => setAmt(x)}>{x}</button>)}</div>
      </div>
      <div className="field">
        <label><span>Slippage on the public swap</span></label>
        <div className="chips">{SLIPS.map((x) => <button key={x} className={slip === x ? "on" : ""} onClick={() => setSlip(x)}>{x / 100}%</button>)}</div>
        <div className="small dim slipnote">{slip === 300 ? "3% is a common setting on swap screens. A bot can take up to this much." : `A bot can take up to ${slip / 100}% of a public swap set like this.`}</div>
      </div>
      <div className="compare">
        <div className="r"><span>x/amm pays right now</span><span className="mono">{q ? (q.ammRefused ? "refuses this size" : amm !== null ? outFmt(amm) : "…") : "…"}</span></div>
        <div className="r"><span>The public swap accepts as little as</span><span className="mono">{least !== null ? outFmt(least) : "…"}</span></div>
        <div className="r"><span>Blind, if nobody trades the other side</span><span className="mono">{alone !== null ? outFmt(alone) : "…"}</span></div>
        <div className="why">Your sealed swap keeps Blind's usual 4% limit. Nobody can read it, so nobody can take it.</div>
      </div>
      <button className="btn day go" onClick={go} disabled={!!block || !!busy}>{busy ? "Sending…" : block || "Send it both ways"}</button>
      {busy && <div className="msg">{busy}</div>}
      {noBank && <div className="msg small">This test account was made before the public lane existed. Use Sealed only, or start over with a new account tomorrow.</div>}
      {err && <div className="msg err">{err}</div>}
    </div>
  );
}

const usdOf = (buy: boolean, v: bigint, mid: string) => (buy ? (Number(v) / 1e18) * (Number(mid) / 1e6) : Number(v) / 1e6);
const fusd = (x: number) => `${Math.abs(x).toFixed(Math.abs(x) < 0.1 ? 3 : 2)} fUSD`;

function attemptDone(a: Attempt) {
  return !!(a.skipped || a.error || a.botPnl !== undefined || (a.order && !a.backHash && a.order !== "bot first"));
}

function DuelView({ d, acc, s, now, onSettled }: { d: Duel; acc: UnifiedAccount; s: State | null; now: number; onSettled: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [res, setRes] = useState<{ height: number; got: bigint } | null>(null);
  const [pubErr, setPubErr] = useState("");
  const [att, setAtt] = useState<Attempt | null>(null);
  const [attGaveUp, setAttGaveUp] = useState(false);
  const [stats, setStats] = useState<BotStats | null>(null);
  const [blindRec, setBlindRec] = useState<BatchRec | null>(null);
  const out = (v: bigint | string, dp = 6) => (d.buy ? `${eth(v, dp)} fETH` : `${usd(v, dp > 6 ? 4 : 2)} fUSD`);
  const inLbl = d.buy ? `${usd(d.amountIn)} fUSD` : `${eth(d.amountIn, 4)} fETH`;

  useEffect(() => { if (Date.now() - d.at < 4000) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, []);

  // The public swap: wait for its block and read what arrived.
  useEffect(() => {
    if (!d.publicHash) return;
    let on = true;
    tokens().then((tk) => publicSwapResult(d.publicHash!, acc.cosmos, bankDenom(d.buy ? tk.fETH.address : tk.fUSD.address)))
      .then((r) => { if (on) { setRes(r); onSettled(); } })
      .catch((e) => on && setPubErr(e?.message ?? "The public swap did not land."));
    return () => { on = false; };
  }, [d.publicHash]);

  // What the bot did with it, from the bot's own record.
  useEffect(() => {
    if (!d.publicHash) return;
    let on = true, t: number | undefined;
    const go = async () => {
      const a = await api.botAttempt(d.publicHash!).catch(() => null);
      if (!on) return;
      if (a) setAtt(a);
      if (a && attemptDone(a)) { api.bot().then((x) => on && setStats(x)).catch(() => undefined); return; }
      if (Date.now() - d.at > 150_000) { setAttGaveUp(true); return; }
      t = window.setTimeout(go, 2000);
    };
    go();
    api.bot().then((x) => on && setStats(x)).catch(() => undefined);
    return () => { on = false; clearTimeout(t); };
  }, [d.publicHash]);

  const done = att ? attemptDone(att) : false;
  const would = att?.victimWouldGet ? BigInt(att.victimWouldGet) : BigInt(d.quoteAmm);
  const hit = att?.order === "bot first" && !!res;
  const took = res ? would - res.got : null;
  const lossBps = att?.victimLossBps ?? (took !== null && would > 0n ? Number((took * 10_000n) / would) : null);
  const record = stats ? `It gets ahead about ${stats.hits} of ${stats.tried} times` : "It does not always get ahead";
  const sameBlock = !!att?.frontHeight && att.frontHeight === att.victimHeight;

  let story: ReactNode = null;
  if (res && att && done) {
    if (hit) story = <>Without the bot you would have got {out(would)}. The bot bought ahead of you {sameBlock ? "in the same block" : "a block earlier"} and sold right after: it took {out(took!, 7)} ({((lossBps ?? 0) / 100).toFixed(2)}%).</>;
    else if (att.order === "missed the block") story = <>The bot saw your swap but landed a block late this time. {record}: <Link to="/proof#bot">see its record</Link>.</>;
    else if (att.order === "victim first") story = <>The bot saw your swap but landed behind it in the same block this time. {record}: <Link to="/proof#bot">see its record</Link>.</>;
    else if (att.skipped) story = <>The bot saw your swap and passed: {att.skipped}. A tighter slippage leaves it less to take. {record}: <Link to="/proof#bot">see its record</Link>.</>;
    else story = <>The bot tried to get ahead and its trade failed this time. {record}: <Link to="/proof#bot">see its record</Link>.</>;
  } else if (res && attGaveUp && !att) {
    story = <>The bot did not pick up this swap. It handles one swap at a time and may have been busy. <Link to="/proof#bot">See its record</Link>.</>;
  }

  // One line in fUSD: what each lane gave up against a clean x/amm swap at its own moment.
  const mine = blindRec?.fills?.find((f) => f.user.toLowerCase() === acc.evm.toLowerCase() && f.amountIn === d.amountIn && !f.standing);
  let compare: string | null = null;
  if (res && done && mine && BigInt(mine.plainAmm) > 0n) {
    const pubLoss = usdOf(d.buy, would - res.got, d.mid);
    const blindEdge = usdOf(d.buy, BigInt(mine.amountOut) - BigInt(mine.plainAmm), d.mid);
    compare = `Against a clean x/amm swap at the same moment, the public swap ${pubLoss > 0.0005 ? `lost ${fusd(pubLoss)} to the bot` : "lost nothing to the bot this time"}, and the sealed swap ${blindEdge >= 0 ? `came out ${fusd(blindEdge)} ahead` : `gave up ${fusd(blindEdge)}`}.`;
  }

  return (
    <div className="duel" ref={ref}>
      <h3 className="colh">Your swap, both ways: {d.buy ? "buy fETH with" : "sell"} {inLbl}</h3>

      <section className="lanep">
        <div className="laneh"><b>Public swap on x/amm</b><span>In full daylight. Anyone watching the mempool reads it.</span></div>
        <Qc name="x/amm pool 3" className="lq" href={d.publicHash ? txUrl(d.publicHash) : undefined} link={d.publicHash ? "your swap" : undefined}>a hybrid signed swap, checked by QoreSign before broadcast. The bot reads QoreChain's public mempool (unconfirmed_txs)</Qc>
        <div className="daylane">
          <div className="ord">
            <div><span>Side</span><b>{d.buy ? "Buy fETH" : "Sell fETH"}</b></div>
            <div><span>Amount</span><b>{inLbl}</b></div>
            <div><span>Least accepted</span><b>{out(d.minOut)}</b></div>
            <div><span>From</span><b>{short(acc.cosmos, 8, 4)}</b></div>
          </div>
          <div className="dres res">
            {d.publicErr || pubErr ? <p className="neg">{d.publicErr || pubErr}</p>
              : !d.publicHash ? <p>Signing your public swap.</p>
              : !res ? <p>In the public mempool, waiting for the next block. The bot can read every line above.</p>
              : <>
                <div className="k">You got</div>
                <div className="big">{out(res.got)}</div>
                {story ? <p>{story}</p> : <p>Reading what the bot did with your swap.</p>}
                {hit && att?.botPnl && <p className="small">The bot kept {att.botPnlDenom === "fETH" ? `${eth(att.botPnl, 7)} fETH` : `${usd(att.botPnl, 4)} fUSD`} after its round trip on the pool.</p>}
              </>}
            <div className="foot2">
              {att?.frontHash && <TxLink h={att.frontHash} label="The bot's buy" />}
              {d.publicHash && <TxLink h={d.publicHash} label="Your swap" />}
              {att?.backHash && <TxLink h={att.backHash} label="The bot's sell" />}
              {res && <span className="mono">Block {blockNo(res.height)}</span>}
            </div>
          </div>
        </div>
      </section>

      <section className="lanep">
        <div className="laneh"><b>Sealed swap on Blind</b><span>Behind the slats until the price is locked.</span></div>
        <Qc name="QoreSeal" className="lq">{STEP_TECH[0].rest}. Settled on QoreChain EVM, checked by pqcVerify 0x0A01</Qc>
        {d.blindErr ? <div className="msg err">{d.blindErr}</div>
          : !d.blind ? <div className="msg">Sealing in your browser.</div>
          : <>
            {!blindRec && <p className="lanecap">Posted on chain as {d.blind.bytes.toLocaleString("en-US")} bytes of sealed data. No side, no amount. It opens when batch {d.blind.batch} settles, in about a minute.</p>}
            <OrderTrack t={d.blind} acc={acc} s={s} now={now} onSettled={onSettled} onRec={setBlindRec} lane />
          </>}
      </section>

      {compare && <p className="verdict">{compare}</p>}
    </div>
  );
}
