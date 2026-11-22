import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { UnifiedAccount } from "@qorechain/sdk";
import { api, batchPath, type Attempt, type BatchRec, type BotStats, type CurrentBatch, type Quote, type State } from "../lib/api";
import {
  loadAccount, newAccount, forgetAccount, storedWords, fund, registerKey, openWindow, approveBoth,
  placeSwap, placeLimit, minOutFor, pub, publicSwapResult, bankDenom, burnerTrader, resumeReveals, type Built, type Trader,
} from "../lib/chain";
import { qorex, connectQorex, approveFromQorex, qorexTrader, plainQorexError, FAUCET_URL, QOREX_INSTALL_URL, type QorexConn } from "../lib/qorex";
import { usd, eth, short, blockNo, pct, edgeBps } from "../lib/fmt";
import { useLive, useNow, phaseStep, TxLink, Copy, Link, refreshState, usePoll, Qc, StepQc } from "../ui";
import { txUrl, STEP_TECH, viaLinkedKey, COMMIT_PLAIN } from "../lib/qore";
import Blind from "../Blind";
import { PairBar, PriceChart, OrderBook, Tape, useSeries } from "./Market";

type StepState = "todo" | "run" | "done" | "err";
interface Setup { keys: StepState; fund: StepState; key: StepState; window: StepState; approve: StepState }
type Hashes = { k: string; h: string }[];

interface Me { fUSD: bigint; fETH: bigint; qor: bigint; bank: { fUSD: bigint; fETH: bigint }; approved: { fUSD: boolean; fETH: boolean }; registered: boolean; proven: boolean }
type Who = { evm: string; cosmos: string };

let tokensP: Promise<State["tokens"]> | null = null;
const tokens = () => (tokensP ??= api.state().then((x) => x.tokens).catch((e) => { tokensP = null; throw e; }));

async function readMe(acc: Who): Promise<Me> {
  const [m, p, b, tk] = await Promise.all([
    api.me(acc.evm),
    api.pqc(acc.cosmos).catch(() => ({ registered: false, possessionProven: false })),
    fetch(`/api/rest/cosmos/bank/v1beta1/balances/${acc.cosmos}`).then((r) => r.json()).catch(() => ({ balances: [] })),
    tokens(),
  ]);
  const of = (d: string) => BigInt((b.balances ?? []).find((x: any) => x.denom.toLowerCase() === d.toLowerCase())?.amount ?? "0");
  return {
    fUSD: BigInt(m.fUSD), fETH: BigInt(m.fETH), qor: of("uqor"), approved: m.approved, registered: p.registered,
    proven: p.registered && p.possessionProven !== false,
    bank: { fUSD: of(bankDenom(tk.fUSD.address)), fETH: of(bankDenom(tk.fETH.address)) },
  };
}

interface Tracked { kind: "swap" | "limit"; batch: number; postHash: string; postBlock: number; bytes: number; buy: boolean; amountIn: string; minOut: string; expiry?: string; at: number; duel?: string; who?: string; index?: number }
/** Orders saved before wallets existed carry no owner: they belong to the browser test account. */
const ownedBy = (x: { who?: string }, t: Trader | null) => !!t && (x.who ? x.who === t.evm.toLowerCase() : t.kind === "burner");
const MODE_KEY = "blind.mode.v1";
type Mode = "burner" | "qorex";
const OFF_KEY = "blind.qorex.off.v1";
const walletOff = () => { try { return localStorage.getItem(OFF_KEY) === "1"; } catch { return false; } };
const setWalletOff = (v: boolean) => { try { if (v) localStorage.setItem(OFF_KEY, "1"); else localStorage.removeItem(OFF_KEY); } catch { /* blocked */ } };
const loadMode = (): Mode => {
  // /app?wallet=qorex (the landing's "Use your QoreX wallet" link) preselects QoreX.
  if (new URLSearchParams(location.search).get("wallet") === "qorex") { try { localStorage.setItem(MODE_KEY, "qorex"); } catch { /* blocked */ } return "qorex"; }
  try { return localStorage.getItem(MODE_KEY) === "qorex" ? "qorex" : "burner"; } catch { return "burner"; }
};
const TRACK_KEY = "blind.orders.v1";
const loadTracked = (): Tracked[] => { try { return JSON.parse(localStorage.getItem(TRACK_KEY) ?? "[]"); } catch { return []; } };
const saveTracked = (t: Tracked[]) => { try { localStorage.setItem(TRACK_KEY, JSON.stringify(t.slice(0, 12))); } catch { /* blocked */ } };
const NO_SETUP: Setup = { keys: "todo", fund: "todo", key: "todo", window: "todo", approve: "todo" };

export default function Trade() {
  // Finish any reveal this browser still owes from before a reload.
  useEffect(() => { resumeReveals(); }, []);
  const { s, down } = useLive();
  // A slow tick for the chart and the order list; the pair bar and the book keep their own faster ones.
  const now = useNow(5000);
  const [acc, setAcc] = useState<UnifiedAccount | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [setup, setSetup] = useState<Setup>(NO_SETUP);
  const [setupMsg, setSetupMsg] = useState<string>("");
  const [setupErr, setSetupErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [hashes, setHashes] = useState<Hashes>([]);
  const [qxHashes, setQxHashes] = useState<Hashes>([]);
  const [tracked, setTracked] = useState<Tracked[]>(loadTracked);
  const [duel, setDuel] = useState<Duel | null>(loadDuel);
  // The QoreChain detail under each step stays one tap away.
  const [tech, setTech] = useState<boolean>(() => { try { return localStorage.getItem("blind.tech") === "1"; } catch { return false; } });
  const toggleTech = () => setTech((t) => { try { localStorage.setItem("blind.tech", t ? "0" : "1"); } catch { /* fine */ } return !t; });
  const [restoring, setRestoring] = useState(() => !!storedWords());
  const [mode, setModeS] = useState<Mode>(loadMode);
  const [wallet, setWallet] = useState<QorexConn | null>(null);
  const [walletMe, setWalletMe] = useState<Me | null>(null);
  const [walletRestoring, setWalletRestoring] = useState(() => loadMode() === "qorex");
  const setMode = (m: Mode) => { setModeS(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* blocked */ } };
  const mineRef = useRef<HTMLElement>(null);

  // Market data: the pool price over time, settled batches, the bot's record and the open batch.
  const { v: market } = usePoll(api.market, 15000);
  const { v: b } = usePoll(api.batches, 6000);
  const { v: bot } = usePoll(api.bot, 8000);
  const [cur, setCur] = useState<CurrentBatch | null>(null);
  const active = !!s && s.phase !== "waiting";
  useEffect(() => {
    if (!active) { setCur(null); return; }
    let on = true;
    const go = () => api.currentBatch().then((x) => on && setCur(x)).catch(() => undefined);
    go();
    const t = setInterval(go, 2500);
    return () => { on = false; clearInterval(t); };
  }, [active, s?.batch.id]);
  const series = useSeries(market, s, now);
  const lastBatch = useMemo(() => (b?.live ?? []).find((r) => r.settled && r.settle && r.fills?.length) ?? null, [b]);

  const burner = useMemo(() => (acc ? burnerTrader(acc) : null), [acc]);
  const qx = useMemo(() => (wallet ? qorexTrader(wallet) : null), [wallet]);
  const trader = mode === "qorex" ? qx : burner;

  const refreshMe = useCallback(async (a: Who | null = acc) => {
    if (!a) return null;
    try { const m = await readMe(a); setMe(m); return m; } catch { return null; }
  }, [acc]);
  const refreshWallet = useCallback(async (w: QorexConn | null = wallet) => {
    if (!w) return null;
    try { const m = await readMe(w); setWalletMe(m); return m; } catch { return null; }
  }, [wallet]);
  const refreshActive = () => (mode === "qorex" ? refreshWallet() : refreshMe());

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
  // Reconnect a QoreX account this site was already allowed to see, without a prompt.
  useEffect(() => {
    if (mode !== "qorex" || wallet) { setWalletRestoring(false); return; }
    let on = true;
    (async () => {
      if (walletOff()) return;
      for (let i = 0; i < 10 && !qorex(); i++) await new Promise((ok) => setTimeout(ok, 100));
      try {
        const w = qorex() ? await connectQorex(true) : null;
        if (on && w) { setWallet(w); await refreshWallet(w); }
      } catch { /* not connected yet: the connect step shows */ }
      finally { if (on) setWalletRestoring(false); }
    })();
    return () => { on = false; };
  }, [mode]);
  useEffect(() => {
    const live = mode === "qorex" ? wallet : acc;
    if (!live) return;
    const tick = () => (mode === "qorex" ? refreshWallet() : refreshMe());
    const t = setInterval(tick, 8000);
    const vis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [mode, acc, wallet, refreshMe, refreshWallet]);

  const burnerReady = setup.approve === "done" && setup.key === "done";
  const walletReady = !!walletMe && walletMe.approved.fUSD && walletMe.approved.fETH && walletMe.proven;
  const ready = mode === "qorex" ? walletReady : burnerReady;
  const activeMe = mode === "qorex" ? walletMe : me;

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
        mark("key", "run"); setSetupMsg("Registering your signing key on QoreChain.");
        const r = await registerKey(a);
        if (r) setHashes((h) => [...h, { k: "Key registered", h: r.hash }]);
      }
      mark("key", "done");
      cur = "window";
      if (!(m.approved.fUSD && m.approved.fETH)) {
        const st = s ?? (await api.state());
        mark("window", "run"); setSetupMsg("Getting ready to approve fUSD and fETH.");
        const w = await openWindow(a, [st.tokens.fUSD.address, st.tokens.fETH.address]);
        setHashes((h) => [...h, { k: "Window", h: w.hash }]);
        mark("window", "done");
        cur = "approve";
        mark("approve", "run"); setSetupMsg("Approving fUSD and fETH for trading.");
        const ap = await approveBoth(a, st);
        setHashes((h) => [...h, ...ap.map((x, i) => ({ k: `Approval ${i + 1}`, h: x }))]);
      }
      mark("window", "done"); mark("approve", "done");
      setSetupMsg("");
      await refreshMe(a);
    } catch (e: any) {
      mark(cur, "err");
      setSetupErr(e?.message ?? "Something failed. Try again.");
      setSetupMsg("");
    } finally { setBusy(false); }
  }

  function addTracked(t: Tracked) {
    const own = { ...t, who: trader?.evm.toLowerCase() };
    setTracked((xs) => { const n = [own, ...xs]; saveTracked(n); return n; });
  }
  const placed = (t: Tracked) => {
    addTracked(t); refreshActive();
    if (!t.duel) setTimeout(() => mineRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 150);
  };
  const mine = tracked.filter((t) => ownedBy(t, trader));
  const shownDuel = duel && ownedBy(duel, trader) ? duel : null;
  const resetBurner = () => {
    const keep = tracked.filter((t) => t.who && t.who !== acc?.evm.toLowerCase());
    forgetAccount(); setAcc(null); setMe(null); setHashes([]); setSetup(NO_SETUP); setSetupMsg(""); setSetupErr(""); setTracked(keep); saveTracked(keep);
    if (duel && ownedBy(duel, burner)) { setDuel(null); saveDuel(null); }
  };
  const disconnect = () => { setWalletOff(true); setWallet(null); setWalletMe(null); };

  // The account chip lives in the top bar, next to the theme switch.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById("navacct")); }, []);

  const bookMine = useMemo(() => mine.filter((t) => t.kind === "swap").map((t) => ({ postHash: t.postHash, bytes: t.bytes, at: t.at, batch: t.batch })), [tracked, trader]);

  return (
    <div className={`page wrap apppage ${tech ? "tech" : ""}`}>
      <div className="term">
        <PairBar s={s} down={down} series={series} lastBatch={lastBatch} />
        <OrderBook s={s} cur={cur} lastBatch={lastBatch} mine={bookMine} />
        <PriceChart series={series} batches={market?.batches ?? []} now={now} />
        <Tape live={b?.live ?? null} bot={bot} />
        <aside className="pn-trade" aria-label="Trade">
          <div className="tstick">
            {ready && trader
              ? <TradeBox s={s} acc={trader} me={activeMe}
                  onDuel={(d) => { const own = { ...d, who: trader.evm.toLowerCase() }; setDuel(own); saveDuel(own); }} onPlaced={placed} />
              : mode === "burner"
                ? <BurnerStart restoring={restoring} acc={acc} setup={setup} busy={busy} msg={setupMsg} err={setupErr} hashes={hashes} onRun={runSetup} onQorex={() => setMode("qorex")} />
                : <QorexStart restoring={walletRestoring} wallet={wallet} me={walletMe} s={s} hashes={qxHashes}
                    addHash={(k, h) => setQxHashes((x) => [...x, { k, h }])}
                    onConnected={(w) => { setWalletOff(false); setWallet(w); refreshWallet(w); }}
                    onRefresh={() => refreshWallet()} onBurner={() => setMode("burner")} />}
          </div>
        </aside>
        <section className="pn-mine" aria-label="Your orders" ref={mineRef}>
          <YourOrders tracked={mine} duel={shownDuel} acc={trader} s={s} now={now} live={b?.live ?? null} onSettled={() => refreshActive()} />
        </section>
      </div>
      <div className="termfoot">
        <span>Test tokens on QoreChain testnet. They have no value.</span>
        <button className="linkbtn techtoggle" onClick={toggleTech}>{tech ? "Hide what QoreChain does at each step" : "Show what QoreChain does at each step"}</button>
      </div>
      {slot && trader && createPortal(
        <AccountChip kind={trader.kind} evm={trader.evm} me={activeMe} hashes={mode === "qorex" ? qxHashes : hashes}
          onRefresh={() => { refreshActive(); }}
          onReset={resetBurner} onDisconnect={disconnect}
          onSwitch={() => setMode(mode === "qorex" ? "burner" : "qorex")} switchBusy={busy} />, slot)}
    </div>
  );
}

function stepsFrom(m: Me): Setup {
  const funded = m.qor > 0n || m.fUSD > 0n;
  const approved = m.approved.fUSD && m.approved.fETH;
  return { keys: "done", fund: funded ? "done" : "todo", key: m.registered ? "done" : "todo", window: approved ? "done" : "todo", approve: approved ? "done" : "todo" };
}

// ------------------------------------------------------------------ account chip, in the top bar
function AccountChip(p: { kind: "burner" | "qorex"; evm: string; me: Me | null; hashes: Hashes; onRefresh: () => void; onReset: () => void; onDisconnect: () => void; onSwitch: () => void; switchBusy: boolean }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setWords(false); setConfirmReset(false); return; }
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", out); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  const { me } = p;
  return (
    <div className="chipw" ref={ref}>
      <button className="chip" onClick={() => setOpen((x) => !x)} aria-expanded={open} aria-haspopup="dialog" title="Your account">
        <span className="chip-bal hideS mono">{me ? `${usd(me.fUSD)} fUSD` : "…"}<i />{me ? `${eth(me.fETH, 4)} fETH` : ""}</span>
        <span className="chip-a mono">{short(p.evm, 6, 4)}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      {open && (
        <div className="chipm" role="dialog" aria-label="Your account">
          <div className="cm-h">
            <span>{p.kind === "qorex" ? "Your QoreX account" : "Test account in this browser"}</span>
            <span className="mono">{short(p.evm, 8, 6)} <Copy text={p.evm} /></span>
          </div>
          <div className="cm-bal">
            <div><span>fUSD</span><b className="mono">{me ? usd(me.fUSD) : "…"}</b></div>
            <div><span>fETH</span><b className="mono">{me ? eth(me.fETH, 5) : "…"}</b></div>
            <div><span>QOR for fees</span><b className="mono">{me ? (Number(me.qor) / 1e6).toFixed(3) : "…"}</b></div>
            {me && (me.bank.fUSD > 0n || me.bank.fETH > 0n) && <div className="kept"><span>Kept for public swaps</span><b className="mono">{usd(me.bank.fUSD)} fUSD, {eth(me.bank.fETH, 4)} fETH</b></div>}
          </div>
          {me && me.fUSD === 0n && me.fETH === 0n && <p className="small dim">No fUSD or fETH here yet. The faucet gives test funds once a day per network.</p>}
          <div className="cm-links">
            <button className="linkbtn" onClick={p.onRefresh}>Refresh</button>
            {p.kind === "burner" && <button className="linkbtn" onClick={() => setWords((x) => !x)}>{words ? "Hide recovery words" : "Show recovery words"}</button>}
            {p.kind === "burner" && (!confirmReset ? <button className="linkbtn" onClick={() => setConfirmReset(true)}>Start over</button>
              : <button className="linkbtn warn" onClick={() => { setOpen(false); p.onReset(); }}>Delete this test account from the browser</button>)}
            {p.kind === "qorex" && <button className="linkbtn" onClick={() => { setOpen(false); p.onDisconnect(); }}>Disconnect</button>}
            <button className="linkbtn" disabled={p.switchBusy} onClick={() => { setOpen(false); p.onSwitch(); }}>{p.kind === "qorex" ? "Use a test account instead" : "Use my QoreX wallet instead"}</button>
          </div>
          {words && (
            <div>
              <div className="words">{storedWords() ?? "Not saved in this browser."}</div>
              <p className="small dim">Anyone with these words controls this test account. Test tokens have no value.</p>
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

// ------------------------------------------------------------------ getting an account, inside the trade box
function Progress({ states, labels }: { states: StepState[]; labels: string[] }) {
  return (
    <ol className="prog" aria-label="Setup progress">
      {states.map((st, i) => <li key={labels[i]} className={st}><i /><span>{labels[i]}</span></li>)}
    </ol>
  );
}

const GUIDE: { k: (keyof Setup)[]; t: string; label: string; q: [string, string]; tx: string[] }[] = [
  { k: ["keys"], t: "Making your keys in this browser.", label: "Keys", q: ["@qorechain/sdk", "a secp256k1 key and an ML-DSA-87 key, both made in this browser"], tx: [] },
  { k: ["fund"], t: "Getting test funds from the Blind faucet.", label: "Test funds", q: ["Faucet tokens", "15 fUSD and 0.005 fETH for sealed swaps, 6 fUSD and 0.002 fETH for a public swap, and QOR for fees. The relayer converts bank coins to ERC-20 with MsgConvertCoin"], tx: ["Funds"] },
  { k: ["key"], t: "Registering your signing key on QoreChain.", label: "Signing key", q: ["MsgRegisterPQCKeyV2", "your ML-DSA-87 key, with proof of possession. After this every transaction is hybrid signed, and QoreSign checks both halves before the relayer broadcasts"], tx: ["Key registered"] },
  { k: ["window", "approve"], t: "Approving fUSD and fETH for trading.", label: "Approvals", q: ["Scoped EVM window", "2 transactions within 600 blocks, to fUSD and fETH only, then the two approvals on QoreChain EVM"], tx: ["Window", "Approval 1"] },
];
function stOf(setup: Setup, ks: (keyof Setup)[]): StepState {
  const v = ks.map((k) => setup[k]);
  if (v.includes("err")) return "err";
  if (v.includes("run")) return "run";
  if (v.every((x) => x === "done")) return "done";
  return "todo";
}

function BurnerStart(p: { restoring: boolean; acc: UnifiedAccount | null; setup: Setup; busy: boolean; msg: string; err: string; hashes: Hashes; onRun: () => void; onQorex: () => void }) {
  if (p.restoring) return <div className="onb"><h2>Your test account</h2><p className="onb-p">Loading the test account saved in this browser.</p></div>;
  const states = GUIDE.map((g) => stOf(p.setup, g.k));
  const cur = states.findIndex((x) => x !== "done");
  const started = !!p.acc || p.busy;
  const g = cur >= 0 ? GUIDE[cur] : null;
  const h = g?.tx.map((k) => p.hashes.find((x) => x.k === k)?.h).find(Boolean);
  return (
    <div className="onb">
      <h2>{started ? "Setting up your test account" : "Start trading in 30 seconds"}</h2>
      <p className="onb-p">{started
        ? "Four short steps run by themselves. Keep this tab open."
        : "One button makes a test account in this browser and fills it with test tokens. No wallet, no sign up."}</p>
      {!started && (
        <ol className="first3">
          <li><b>1</b>Make your account. It takes one tap.</li>
          <li><b>2</b>Buy or sell fETH. Your order is sealed before it leaves this browser.</li>
          <li><b>3</b>See what you got, next to the same swap sent in public.</li>
        </ol>
      )}
      {started && <Progress states={states} labels={GUIDE.map((x) => x.label)} />}
      {started && g && <p className="onb-step" role="status">Step {cur + 1} of 4. {p.busy ? p.msg || g.t : p.err ? "This step did not finish." : "Ready to continue."}</p>}
      {p.err && <div className="msg err">{p.err}</div>}
      <button className="btn day go" onClick={p.onRun} disabled={p.busy}>
        {p.busy ? "Working…" : p.acc ? (p.err ? "Try again" : "Finish setting up") : "Make a test account in this browser"}
      </button>
      {!p.busy && <button className="btn alt go" onClick={p.onQorex}>Use my QoreX wallet</button>}
      {!started && <p className="onb-f">Test tokens only. They have no value. The faucet gives each network one test account a day.</p>}
      {g && <Qc name={g.q[0]} href={h ? txUrl(h) : undefined} link={h ? "your transaction" : undefined}>{g.q[1]}</Qc>}
    </div>
  );
}

function QorexStart(p: { restoring: boolean; wallet: QorexConn | null; me: Me | null; s: State | null; hashes: Hashes; addHash: (k: string, h: string) => void; onConnected: (w: QorexConn) => void; onRefresh: () => Promise<Me | null> | void; onBurner: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const installed = !!qorex();
  const { wallet: w, me, hashes } = p;
  const funded = !!me && me.qor > 0n;
  const approved = !!me && me.approved.fUSD && me.approved.fETH;
  const proven = !!me && me.proven;
  const states: StepState[] = [
    w ? "done" : err && busy === "" && !w ? "err" : busy === "connect" ? "run" : "todo",
    w && funded ? "done" : busy === "fund" ? "run" : "todo",
    approved ? "done" : busy === "approve" ? "run" : "todo",
    proven ? "done" : "todo",
  ];
  const cur = states.findIndex((x) => x !== "done");

  async function connect() {
    setErr(""); setBusy("connect");
    try { const c = await connectQorex(); if (c) p.onConnected(c); }
    catch (e: any) { setErr(plainQorexError(e)); }
    finally { setBusy(""); }
  }
  async function approve() {
    if (!w) return;
    setErr(""); setBusy("approve");
    try {
      const st = p.s ?? (await api.state());
      await approveFromQorex(w, st, (k, h) => p.addHash(k, h));
      await p.onRefresh();
    } catch (e: any) { setErr(plainQorexError(e)); }
    finally { setBusy(""); }
  }
  async function getFunds() {
    if (!w) return;
    setErr(""); setBusy("fund");
    try {
      const r = await api.fund(w.cosmos, w.evm);
      p.addHash("Test funds", r.hash);
      for (let i = 0; i < 40; i++) { const t = await api.cosmosTx(r.hash).catch(() => null); if (t?.found) break; await new Promise((ok) => setTimeout(ok, 1500)); }
      await p.onRefresh();
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(""); }
  }
  async function check() {
    setErr(""); setBusy("check");
    try { await p.onRefresh(); } finally { setBusy(""); }
  }

  const steps: { label: string; q: [string, string]; body: ReactNode; tx?: string }[] = [
    {
      label: "Connect",
      q: ["QoreX", "Your QoreX wallet signs your order with your registered ML-DSA-87 key under QoreChain's message domain; the contract checks that signature on chain."],
      body: !installed ? (
        <>
          <p className="onb-p">QoreX is not installed in this browser. After installing, reload this page.</p>
          <a className="btn day go" href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer">Get QoreX for Chrome</a>
        </>
      ) : (
        <>
          <p className="onb-p">Blind asks QoreX for your account on testnet. Use an Ethereum account (coin 60) in QoreX.</p>
          <button className="btn day go" onClick={connect} disabled={!!busy}>{busy === "connect" ? "Waiting for QoreX…" : err ? "Try again" : "Connect QoreX"}</button>
        </>
      ),
    },
    {
      label: "Test funds",
      q: ["Blind faucet", "test QOR for fees, fUSD and fETH converted to ERC-20 with MsgConvertCoin, and bank coins for a public swap"],
      tx: "Test funds",
      body: (
        <>
          <p className="onb-p">One button sends your QoreX account test QOR for fees, plus fUSD and fETH to trade. Once a day per network.</p>
          <button className="btn day go" onClick={getFunds} disabled={!!busy}>{busy === "fund" ? "Sending test funds…" : "Get test funds"}</button>
          <div className="onb-links">
            <a className="linkbtn" href={FAUCET_URL} target="_blank" rel="noreferrer">More QOR from the QoreChain faucet</a>
            <button className="linkbtn" onClick={check} disabled={!!busy}>{busy === "check" ? "Checking…" : "Check again"}</button>
          </div>
        </>
      ),
    },
    {
      label: "Approvals",
      q: ["Scoped EVM window", "QoreX opens a one transaction window to each token by itself, then sends the approval on QoreChain EVM"],
      tx: "Approval fUSD",
      body: (
        <>
          <p className="onb-p">Lets settlement move the tokens you sell, fUSD and fETH only. Two approvals in QoreX.</p>
          <button className="btn day go" onClick={approve} disabled={!!busy}>{busy === "approve" ? "Approve in QoreX…" : err ? "Try again" : "Approve in QoreX"}</button>
          {busy === "approve" && <div className="msg">Confirm each approval in the QoreX window. Each one waits for its block.</div>}
        </>
      ),
    },
    {
      label: "Signing key",
      q: ["MsgRegisterPQCKeyV2", "QoreX registers your ML-DSA-87 key with proof of possession; the contract only accepts orders from a proven key"],
      body: (
        <>
          <p className="onb-p">{me?.registered ? "Your signing key is on chain without proof of possession, so the contract would refuse your orders. Rotate the key in QoreX, then check again." : "QoreX registers your signing key with your account's first transaction, and the approvals count. Once they land, check again."}</p>
          <button className="btn day go" onClick={check} disabled={!!busy}>{busy === "check" ? "Checking…" : "Check again"}</button>
        </>
      ),
    },
  ];

  if (p.restoring) return <div className="onb"><h2>Your QoreX wallet</h2><p className="onb-p">Looking for your QoreX account.</p></div>;
  const g = steps[Math.max(0, cur)];
  const h = g.tx ? hashes.find((x) => x.k === g.tx)?.h : undefined;
  return (
    <div className="onb">
      <h2>Trade from your QoreX wallet</h2>
      <Progress states={states} labels={steps.map((x) => x.label)} />
      <p className="onb-step" role="status">Step {Math.max(0, cur) + 1} of 4</p>
      {g.body}
      {err && <div className="msg err">{err}</div>}
      {!busy && <button className="btn alt go" onClick={p.onBurner}>Make a test account in this browser instead</button>}
      <Qc name={g.q[0]} href={h ? txUrl(h) : undefined} link={h ? "your transaction" : undefined}>{g.q[1]}</Qc>
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


// ------------------------------------------------------------------ the trade box
const CMP_KEY = "blind.compare.v1";
/** First time here the public swap rides along, so the two lanes can be compared. */
const loadCompare = () => { try { return localStorage.getItem(CMP_KEY) !== "0"; } catch { return true; } };

function TradeBox({ s, acc, me, onDuel, onPlaced }: { s: State | null; acc: Trader; me: Me | null; onDuel: (d: Duel) => void; onPlaced: (t: Tracked) => void }) {
  const [tab, setTab] = useState<"swap" | "limit">("swap");
  return (
    <div className="tbox">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "swap"} className={tab === "swap" ? "on" : ""} onClick={() => setTab("swap")}>Swap</button>
        <button role="tab" aria-selected={tab === "limit"} className={tab === "limit" ? "on" : ""} onClick={() => setTab("limit")}>Limit order</button>
      </div>
      {tab === "swap"
        ? <SwapForm s={s} acc={acc} me={me} onDuel={onDuel} onPlaced={onPlaced} />
        : <LimitBox need="" s={s} acc={acc} me={me} ready onPlaced={onPlaced} />}
    </div>
  );
}

/** One form for a sealed swap. With "compare" on, the same swap also goes out as a plain public swap at the same moment. */
function SwapForm({ s, acc, me, onDuel, onPlaced }: { s: State | null; acc: Trader; me: Me | null; onDuel: (d: Duel) => void; onPlaced: (t: Tracked) => void }) {
  const [buy, setBuy] = useState(true);
  const [amt, setAmt] = useState("5");
  const [bps, setBps] = useState(400);
  const [slip, setSlip] = useState(300);
  const [cmp, setCmpS] = useState<boolean>(loadCompare);
  const setCmp = (v: boolean) => { setCmpS(v); try { localStorage.setItem(CMP_KEY, v ? "1" : "0"); } catch { /* blocked */ } };
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [sealed, setSealed] = useState<Built | null>(null);

  const unit = buy ? "fUSD" : "fETH";
  // No public coins of the kind this side spends: the swap goes sealed only.
  const noBank = !!me && (buy ? me.bank.fUSD : me.bank.fETH) === 0n;
  const compare = cmp && !noBank;
  const amount = useMemo(() => toUnits(amt, buy ? 6 : 18), [amt, buy]);
  const q = useQuote(buy ? "buy" : "sell", amount);
  const outFmt = (v: bigint) => (buy ? `${eth(v, 6)} fETH` : `${usd(v)} fUSD`);
  const amm = q?.plainAmm ? BigInt(q.plainAmm) : null;
  const alone = q ? BigInt(q.blindIfAlone) : null;
  const least = amm !== null ? (amm * BigInt(10_000 - slip)) / 10_000n : null;
  const minOut = s && amount > 0n ? minOutFor(buy, amount, BigInt(s.pool.mid), BigInt(bps)) : null;
  const sealBal = me ? (buy ? me.fUSD : me.fETH) : 0n;
  const pubBal = me ? (buy ? me.bank.fUSD : me.bank.fETH) : 0n;
  const presets = buy ? (compare ? ["2", "5"] : ["2", "5", "10"]) : compare ? ["0.001", "0.0015"] : ["0.001", "0.002", "0.004"];
  const shortPublic = compare && amount > 0n && amount <= sealBal && amount > pubBal;
  const block = amount <= 0n ? "Enter an amount"
    : amount > sealBal ? `Not enough ${unit}`
    : shortPublic ? `Not enough ${unit} for the public swap`
    : compare && me && me.qor < 60_000n ? "Not enough QOR for the network fee"
    : compare && q?.ammRefused ? "Too large for the public pool. Try a smaller amount"
    : q && !q.withinMakerSize ? "Too large for one batch. Try a smaller amount" : "";
  const side = (b: boolean) => { setBuy(b); setAmt(b ? "5" : compare ? "0.0015" : "0.002"); };
  // Start from an amount this account can actually send: the largest quick amount that fits, else what it holds.
  const fitted = useRef("");
  useEffect(() => {
    if (!me) return;
    const key = `${buy}:${compare}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const cap = compare && pubBal < sealBal ? pubBal : sealBal;
    if (cap <= 0n || amount <= cap) return;
    const dec = buy ? 6 : 18, dp = buy ? 2 : 4;
    const fit = [...presets].reverse().find((x) => toUnits(x, dec) <= cap);
    const unitDp = 10n ** BigInt(dec - dp);
    setAmt(fit ?? String(Number(cap / unitDp) / 10 ** dp));
  }, [!!me, buy, compare]);

  async function goSealed() {
    setErr(""); setSealed(null); setBusy(acc.kind === "qorex" ? "Approve the order signature in QoreX. It is sealed in this browser after." : "Signing and sealing in your browser.");
    try {
      const r = await placeSwap(acc, { buy, amountIn: amount, bps: BigInt(bps) }, (b) => { setSealed(b); setBusy("Sealed. Posting it on chain."); });
      onPlaced({ kind: "swap", batch: r.batch, postHash: r.hash, postBlock: r.block, bytes: r.built.bytes, buy, amountIn: amount.toString(), minOut: r.built.order.minOut.toString(), at: Date.now(), index: r.index });
      setBusy("");
      refreshState();
    } catch (e: any) { setErr(e?.message ?? "The order was not placed."); setBusy(""); }
  }

  async function goBoth() {
    setErr(""); setBusy("Getting the public pool price.");
    try {
      const st = s ?? (await api.state());
      const fresh = await api.quote(buy ? "buy" : "sell", amount);
      if (!fresh.plainAmm) throw new Error("The public pool refuses this size. Try a smaller amount.");
      const pubMin = (BigInt(fresh.plainAmm) * BigInt(10_000 - slip)) / 10_000n;
      const id = String(Date.now());
      let d: Duel = { id, at: Date.now(), buy, amountIn: amount.toString(), slipBps: slip, mid: st.pool.mid, quoteAmm: fresh.plainAmm, minOut: pubMin.toString() };
      onDuel(d);
      setBusy("Sending both at once.");
      // Fire both lanes in the same tick.
      const pubP = acc.publicSwap(st, { buy, amountIn: amount, minOut: pubMin })
        .then((h) => { d = { ...d, publicHash: h }; onDuel(d); })
        .catch((e) => { d = { ...d, publicErr: e?.message ?? "The public swap was not sent." }; onDuel(d); });
      const blindP = placeSwap(acc, { buy, amountIn: amount, bps: BigInt(bps) })
        .then((r) => {
          const t: Tracked = { kind: "swap", batch: r.batch, postHash: r.hash, postBlock: r.block, bytes: r.built.bytes, buy, amountIn: amount.toString(), minOut: r.built.order.minOut.toString(), at: Date.now(), duel: id, index: r.index };
          onPlaced(t);
          d = { ...d, blind: t }; onDuel(d);
          refreshState();
        })
        .catch((e) => { d = { ...d, blindErr: e?.message ?? "The sealed swap was not placed." }; onDuel(d); });
      await Promise.all([pubP, blindP]);
      setBusy("");
    } catch (e: any) { setErr(e?.message ?? "Nothing was sent."); setBusy(""); }
  }
  const go = () => { if (block || busy) return; return compare ? goBoth() : goSealed(); };

  return (
    <div className="sform">
      <div className="side" role="radiogroup" aria-label="Side">
        <button role="radio" aria-checked={buy} className={buy ? "on buy" : ""} onClick={() => side(true)}>Buy</button>
        <button role="radio" aria-checked={!buy} className={!buy ? "on sell" : ""} onClick={() => side(false)}>Sell</button>
      </div>

      <div className="field">
        <label><span>{compare ? "You pay, on each side" : "You pay"}</span>
          {me && <span>{compare ? `Sealed ${buy ? usd(me.fUSD) : eth(me.fETH, 4)}, public ${buy ? usd(me.bank.fUSD) : eth(me.bank.fETH, 4)}` : `Balance ${buy ? usd(me.fUSD) : eth(me.fETH, 5)}`} {unit}</span>}</label>
        <div className="amt"><input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(",", "."))} aria-label={`Amount in ${unit}`} /><span className="u">{unit}</span></div>
        <div className="chips">{presets.map((x) => <button key={x} className={amt === x ? "on" : ""} onClick={() => setAmt(x)}>{x}</button>)}</div>
      </div>

      <div className="recv">
        <span>You receive (estimated)</span>
        <b className="mono">{alone !== null ? outFmt(alone) : amount > 0n ? "…" : buy ? "0 fETH" : "0 fUSD"}</b>
        <small>If others trade the other side in your batch, you get more.</small>
      </div>

      <div className="field lim">
        <label><span>Your limit, away from the pool price</span><span className="mono">{(bps / 100).toFixed(1)}%</span></label>
        <input type="range" min={50} max={1000} step={50} value={bps} onChange={(e) => setBps(Number(e.target.value))} aria-label="Limit in percent" />
        <div className="kv2"><span>The least you accept</span><span className="mono">{minOut !== null ? outFmt(minOut) : "…"}</span></div>
        <div className="kv2"><span>Public pool pays right now</span><span className="mono">{q ? (q.ammRefused ? "refuses this size" : amm !== null ? outFmt(amm) : "…") : "…"}</span></div>
      </div>

      <div className={`cmpbox ${compare ? "on" : ""}`}>
        <label className="cmp">
          <input type="checkbox" checked={compare} disabled={noBank || !!busy} onChange={(e) => setCmp(e.target.checked)} />
          <span>Also send it as a public swap, to compare</span>
        </label>
        {noBank ? <p>This account has no {unit} left for a public swap, so this one goes sealed only.</p>
          : compare ? (
            <>
              <p>The same swap goes to the public pool at the same moment, so you pay on each side. A bot we run watches that pool.</p>
              <div className="slip"><span>Public swap slippage</span><div className="chips">{SLIPS.map((x) => <button key={x} className={slip === x ? "on" : ""} onClick={() => setSlip(x)}>{x / 100}%</button>)}</div></div>
              <div className="kv2"><span>The public swap accepts as little as</span><span className="mono">{least !== null ? outFmt(least) : "…"}</span></div>
            </>
          ) : <p>Off: only the sealed swap is sent.</p>}
      </div>

      <button className={`btn day go ${buy ? "" : "sell"}`} onClick={go} disabled={!!block || !!busy}>{busy ? "Sending…" : block || (buy ? "Buy fETH" : "Sell fETH")}</button>
      {!busy && !err && <p className="sealnote">{shortPublic ? "Or untick the public swap and send it sealed only." : "Only a fingerprint leaves this browser until the price is locked. If the batch price is worse than your limit, nothing moves."}</p>}
      {busy && <div className="msg" role="status">{busy}</div>}
      {sealed && busy && <div className="msg small">{sealed.fingerprint ? "Only a 32 byte fingerprint is sent. Nobody can read the side or the amount until the price is locked." : `${sealed.bytes.toLocaleString("en-US")} bytes sealed. Nobody can read the side or the amount.`}</div>}
      {err && <div className="msg err">{err}</div>}
      <Qc name={STEP_TECH[0].name}>{STEP_TECH[0].rest}. Posted to BlindSettlement on QoreChain EVM</Qc>
    </div>
  );
}

// ------------------------------------------------------------------ your orders
interface OrderItem { id: string; at: number; kind: "both" | "swap" | "limit"; t?: Tracked; d?: Duel }

function orderStatus(t: Tracked | undefined, live: BatchRec[] | null, s: State | null, me: string): { text: string; tone: "" | "pos" | "neg" | "on" } {
  if (!t) return { text: "Sending", tone: "on" };
  const got = (f: NonNullable<BatchRec["fills"]>[number]) => {
    const e = edgeBps(f);
    return { text: `Got ${f.buy ? `${eth(f.amountOut, 6)} fETH` : `${usd(f.amountOut)} fUSD`}${e === null ? "" : `, ${pct(e)} vs public pool`}`, tone: (e !== null && e < 0 ? "neg" : "pos") as "neg" | "pos" };
  };
  if (t.kind === "limit") {
    for (const r of live ?? []) {
      const f = (r.fills ?? []).find((x) => x.standing && x.user.toLowerCase() === me && x.amountIn === t.amountIn);
      if (f) return got(f);
    }
    return { text: "Waiting for your price", tone: "on" };
  }
  const rec = live?.find((x) => x.batch === t.batch) ?? null;
  if (rec) {
    const f = rec.fills?.find((x) => x.user.toLowerCase() === me && x.amountIn === t.amountIn && !x.standing);
    return f ? got(f) : { text: "Not filled. Nothing moved", tone: "neg" };
  }
  if (s && s.batch.id === t.batch && s.phase !== "waiting") {
    const m: Record<string, string> = { intake: "Sealed, waiting for the batch to close", quoting: "Locking the price", revealing: "Price locked, revealing your order", settling: "Settling", hedging: "Settled" };
    return { text: m[s.phase] ?? "Sealed", tone: "on" };
  }
  return { text: "Sealed", tone: "on" };
}

function YourOrders({ tracked, duel, acc, s, now, live, onSettled }: { tracked: Tracked[]; duel: Duel | null; acc: Trader | null; s: State | null; now: number; live: BatchRec[] | null; onSettled: () => void }) {
  const items = useMemo(() => {
    const out: OrderItem[] = tracked.filter((t) => !t.duel).map((t) => ({ id: t.postHash, at: t.at, kind: t.kind, t }));
    if (duel) out.push({ id: `duel${duel.id}`, at: duel.at, kind: "both", d: duel, t: duel.blind });
    return out.sort((a, b) => b.at - a.at);
  }, [tracked, duel]);
  // The newest order is open; any other opens on a tap.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const newest = items[0]?.id;
  useEffect(() => { setPicked(undefined); }, [newest]);
  const openId = picked === undefined ? newest : picked;
  const me = acc?.evm.toLowerCase() ?? "";
  const when = (t: number) => { const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
  return (
    <>
      <div className="pnh"><h2>Your orders</h2><span className="pnn">{items.length ? `${items.length} in this browser` : ""}</span></div>
      {!acc || !items.length ? <p className="bk-empty">{acc ? "No orders yet. Your swaps and their results show here." : "Your swaps and their results show here once you have an account."}</p> : (
        <div className="ords">
          <div className="or-cols"><span>Time</span><span>Type</span><span>Order</span><span>Status</span><span /></div>
          {items.map((it) => {
            const src = it.d ?? it.t!;
            const st = orderStatus(it.t, live, s, me);
            const open = openId === it.id;
            return (
              <div className={`orw ${open ? "open" : ""}`} key={it.id}>
                <button className="or-row" aria-expanded={open} onClick={() => setPicked(open ? null : it.id)}>
                  <span className="mono dim">{when(it.at)}</span>
                  <span>{it.kind === "both" ? "Sealed and public" : it.kind === "limit" ? "Limit order" : "Sealed swap"}</span>
                  <span><b className={src.buy ? "pos" : "neg"}>{src.buy ? "Buy" : "Sell"}</b> {src.buy ? `fETH with ${usd(src.amountIn)} fUSD` : `${eth(src.amountIn, 4)} fETH`}</span>
                  <span className={`or-st ${st.tone}`}>{it.d?.blindErr ? "The sealed swap was not placed" : st.text}</span>
                  <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
                </button>
                {open && (
                  <div className="ordb">
                    {it.d ? <DuelView key={it.d.id} d={it.d} acc={acc} s={s} now={now} onSettled={onSettled} />
                      : <OrderTrack key={it.t!.postHash} t={it.t!} acc={acc} s={s} now={now} onSettled={onSettled} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}


function LimitBox({ s, acc, me, ready, onPlaced, need }: { need: string; s: State | null; acc: Trader | null; me: Me | null; ready: boolean; onPlaced: (t: Tracked) => void }) {
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
  const block = !acc ? need : !ready ? "Finish setting up your account" : amount <= 0n ? "Enter an amount" : amount > bal ? `Not enough ${buy ? "fUSD" : "fETH"}` : "";
  async function go() {
    if (!acc || block) return;
    setErr(""); setBusy(acc.kind === "qorex" ? "Approve the order signature in QoreX. It is sealed to the standing key after." : "Signing and sealing to the standing key.");
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


// ------------------------------------------------------------------ one order, tracked
function OrderTrack({ t, acc, s, onSettled, onRec, lane }: { t: Tracked; acc: Trader; s: State | null; now: number; onSettled: () => void; onRec?: (r: BatchRec) => void; lane?: boolean }) {
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
  const myReveal = t.index != null ? rec?.reveals?.find((x) => x.index === t.index) : undefined;
  const items: { st: string; text: string; h?: string; on: boolean; done: boolean; q?: ReactNode }[] = [
    { st: "Signed", text: `${t.bytes === 32 ? "A 32 byte fingerprint" : `${t.bytes.toLocaleString("en-US")} bytes sealed`}, ${acc.kind === "qorex" ? "signed in QoreX" : "signed in this browser"}`, on: false, done: true, q: <StepQc i={0} /> },
    { st: "Posted", text: `Batch ${t.batch}, block ${blockNo(t.postBlock)}`, h: t.postHash, on: false, done: true, q: <StepQc i={1} /> },
    { st: "Price locked", text: rec?.commit ? `Market maker price locked in block ${blockNo(rec.commit.block)}` : "The market maker locks its price after intake closes", h: rec?.commit?.hash, on: step === 2 || step === 1, done: step > 2, q: rec?.commit && !viaLinkedKey(rec.commit.hash) ? <Qc name={COMMIT_PLAIN.name}>{COMMIT_PLAIN.rest}</Qc> : <StepQc i={2} href="/proof#agent" link="the rule" /> },
    { st: rec?.open ? "Opened" : "Revealed", text: rec?.open ? `Batch key revealed in block ${blockNo(rec.open.block)}` : myReveal ? `Your browser revealed it in block ${blockNo(myReveal.block)}` : "Your browser reveals it once the price is locked", h: rec?.open?.hash ?? myReveal?.hash, on: step === 3, done: step > 3, q: <StepQc i={3} /> },
    { st: "Settled", text: rec?.settle ? `One price for everyone, block ${blockNo(rec.settle.block)}` : rec ? "This batch did not settle" : "One transaction settles the batch", h: rec?.settle?.hash, on: step === 4, done: !!rec?.settle, q: <StepQc i={4}>{rec?.settle && mine >= 0 ? "checked your ML-DSA-87 signature against the key pqcKeyStatus 0x0A02 reports" : undefined}</StepQc> },
  ];
  return (
    <div className="track">
      {!lane && <div className="trackh"><b>{sideLine}</b><span className="dim">batch {t.batch}</span></div>}
      <Blind state={rec ? "open" : step === 3 || step === 4 ? "opening" : "closed"} flat={!lane} className={lane ? "lane" : "small"} label={lane ? `Your sealed swap, batch ${t.batch}` : undefined}>
        {rec && mine >= 0 ? <Result f={rec.fills![mine]} rec={rec} lead={lane ? (t.bytes === 32 ? "The bot saw a 32 byte fingerprint, the same as every other order: no side, no amount." : `The bot saw a sealed envelope: ${t.bytes.toLocaleString("en-US")} bytes, the same size as every other order, no side, no amount.`) : undefined} />
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
  publicHash?: string; publicErr?: string; blind?: Tracked; blindErr?: string; who?: string;
}
const DUEL_KEY = "blind.duel.v1";
function loadDuel(): Duel | null { try { return JSON.parse(localStorage.getItem(DUEL_KEY) ?? "null"); } catch { return null; } }
function saveDuel(d: Duel | null) { try { if (d) localStorage.setItem(DUEL_KEY, JSON.stringify(d)); else localStorage.removeItem(DUEL_KEY); } catch { /* blocked */ } }

const SLIPS = [100, 300, 500];


const usdOf = (buy: boolean, v: bigint, mid: string) => (buy ? (Number(v) / 1e18) * (Number(mid) / 1e6) : Number(v) / 1e6);
const fusd = (x: number) => `${Math.abs(x).toFixed(Math.abs(x) < 0.1 ? 3 : 2)} fUSD`;

function attemptDone(a: Attempt) {
  return !!(a.skipped || a.error || a.botPnl !== undefined || (a.order && !a.backHash && a.order !== "bot first"));
}

function DuelView({ d, acc, s, now, onSettled }: { d: Duel; acc: Trader; s: State | null; now: number; onSettled: () => void }) {
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
              : !d.publicHash ? <p>{acc.kind === "qorex" ? "Approve the public swap in QoreX." : "Signing your public swap."}</p>
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
        <Qc name={STEP_TECH[0].name} className="lq">{STEP_TECH[0].rest}. Settled on QoreChain EVM, checked by pqcVerify 0x0A01</Qc>
        {d.blindErr ? <div className="msg err">{d.blindErr}</div>
          : !d.blind ? <div className="msg">{acc.kind === "qorex" ? "Approve the order signature in QoreX, then it is sealed in this browser." : "Sealing in your browser."}</div>
          : <>
            {!blindRec && <p className="lanecap">Posted on chain as {d.blind.bytes.toLocaleString("en-US")} bytes of sealed data. No side, no amount. It opens when batch {d.blind.batch} settles, in about a minute.</p>}
            <OrderTrack t={d.blind} acc={acc} s={s} now={now} onSettled={onSettled} onRec={setBlindRec} lane />
          </>}
      </section>

      {compare && <p className="verdict">{compare}</p>}
    </div>
  );
}
