import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type MouseEvent } from "react";
import { api, type State, type Phase, type Fill, type BatchRec } from "./lib/api";
import { short, pct, edgeBps, price, blockNo, eth } from "./lib/fmt";
import { EXPLORER } from "./lib/const";
import type { BlindState } from "./Blind";

export const REPO = "https://github.com/jenzylove/blind";

// ------------------------------------------------------------------ routing
const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));
export function navigate(to: string) {
  history.pushState(null, "", to);
  listeners.forEach((l) => l());
  if (!to.includes("#")) window.scrollTo(0, 0);
  else setTimeout(() => document.getElementById(to.split("#")[1])?.scrollIntoView(), 60);
}
export function usePath() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => location.pathname);
}
export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string; [k: string]: any }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault(); navigate(to);
  };
  return <a href={to} onClick={onClick} className={className} {...rest}>{children}</a>;
}

// ------------------------------------------------------------------ one shared live state poll
let live: State | null = null;
let liveErr = false;
const subs = new Set<() => void>();
let timer: number | undefined;
async function pull() {
  try { live = await api.state(); liveErr = false; } catch { liveErr = true; }
  subs.forEach((s) => s());
}
export function refreshState() { return pull(); }
export function useLive(): { s: State | null; down: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    subs.add(f);
    if (!timer) { pull(); timer = window.setInterval(pull, 3000); }
    return () => { subs.delete(f); };
  }, []);
  return { s: live, down: liveErr };
}

export function useNow(ms = 500) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

/** Fetch once and re-fetch on an interval. */
export function usePoll<T>(f: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let on = true;
    const go = () => f().then((x) => { if (on) { setV(x); setErr(false); } }).catch(() => on && setErr(true));
    go();
    const t = setInterval(go, ms);
    return () => { on = false; clearInterval(t); };
  }, deps);
  return { v, err };
}

// ------------------------------------------------------------------ theme
export function ThemeToggle() {
  const [t, setT] = useState<string>(() => document.documentElement.dataset.theme ?? "dark");
  const flip = () => {
    const n = t === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem("blind.theme", n); } catch { /* blocked */ }
    setT(n);
  };
  return (
    <button className="iconbtn" onClick={flip} aria-label={t === "dark" ? "Use the light room" : "Use the dark room"} title={t === "dark" ? "Light room" : "Dark room"}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        {t === "dark"
          ? <><circle cx="9" cy="9" r="3.6" fill="currentColor" />{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <rect key={a} x="8.4" y="1" width="1.2" height="3" rx=".6" fill="currentColor" transform={`rotate(${a} 9 9)`} />)}</>
          : <path d="M12.5 11.8A6 6 0 0 1 6.2 3.5a6 6 0 1 0 6.3 8.3z" fill="currentColor" />}
      </svg>
    </button>
  );
}

// ------------------------------------------------------------------ brand
/** Three stacked slats of decreasing width. */
export function Logo() {
  return <span className="logo"><i aria-hidden><b /><b /><b /></i>blind</span>;
}

/** A small blind for table rows: closed while sealed, open once settled. */
export function SlatGlyph({ state }: { state: BlindState }) {
  return <span className={`glyph ${state}`} role="img" aria-label={state === "open" ? "settled" : state === "opening" ? "opening" : "sealed"}><i /><i /><i /></span>;
}

/** The newest settled batch with fills, from app batches and test runs together. */
export function latestSettled(b: { live: BatchRec[]; testRuns: BatchRec[] } | null): BatchRec | null {
  if (!b) return null;
  const all = [...b.live, ...b.testRuns].filter((r) => r.settled && r.fills?.length && r.settle && r.commit && r.open && r.create);
  all.sort((a, c) => c.batch - a.batch);
  return all[0] ?? null;
}

// ------------------------------------------------------------------ phases
export const STEPS = ["Seal", "Post", "Commit price", "Open", "Settle"] as const;
export function phaseStep(p: Phase): number {
  return { waiting: -1, intake: 1, quoting: 2, opening: 3, settling: 4, hedging: 5 }[p];
}
/** Closed while orders are sealed, opening at the reveal, open once settled. */
export function phaseBlind(p: Phase | undefined): BlindState {
  if (p === "opening" || p === "settling") return "opening";
  if (p === "hedging" || p === "waiting") return "open";
  return "closed";
}
export function phaseLine(s: State, now: number) {
  switch (s.phase) {
    case "waiting": return "No batch open. The next sealed order opens one.";
    case "intake": {
      const left = s.batch.closesAt ? Math.max(0, Math.ceil((s.batch.closesAt - now) / 1000)) : null;
      return left !== null ? `Batch ${s.batch.id} is taking sealed orders. Closes in ${left} s.` : `Batch ${s.batch.id} is taking sealed orders.`;
    }
    case "quoting": return `Batch ${s.batch.id} is closed. The market maker is locking its price on chain.`;
    case "opening": return `Batch ${s.batch.id}: the price is on chain. The blinds are opening.`;
    case "settling": return `Batch ${s.batch.id}: orders opened from chain data. Settling at one price.`;
    case "hedging": return `Batch ${s.batch.id} settled. The market maker is rebalancing on x/amm.`;
  }
}

// ------------------------------------------------------------------ bits
export function Edge({ f }: { f: Fill }) {
  const e = edgeBps(f);
  if (e === null) return <span className="edge mute">x/amm refused this size</span>;
  return <span className={`edge ${e < 0 ? "neg" : "pos"}`}>{pct(e)}</span>;
}

export function TxLink({ h, label }: { h?: string; label?: string }) {
  if (!h) return null;
  return <a href={`${EXPLORER}/tx/${h.startsWith("0x") ? h : h.toUpperCase()}`} target="_blank" rel="noreferrer" className="txl">{label ?? short(h, 6, 4)} <span aria-hidden>↗</span></a>;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button className="linkbtn" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }).catch(() => undefined); }}>{done ? "Copied" : label}</button>;
}

/** Fade sections in as they enter the screen. */
export function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll(".rv:not(.in)"));
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  });
}

// ------------------------------------------------------------------ the committed curve
export function Curve({ rec }: { rec: BatchRec | null }) {
  if (!rec?.commit || !rec.settle) return null;
  const c = rec.commit;
  const bid = Number(c.bid), ask = Number(c.ask);
  const bidMax = Number(c.bidMax ?? c.bid), askMax = Number(c.askMax ?? c.ask), mid = Number(c.mid);
  const lo = Math.min(bidMax, Number(rec.settle.price)) * 0.999, hi = Math.max(askMax, Number(rec.settle.price)) * 1.001;
  const W = 320, H = 170;
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const maxNet = Number(c.maxNet);
  const x = (n: number) => W / 2 + (n / maxNet) * (W / 2);
  const net = -Number(rec.settle.makerBase);
  const px = x(Math.max(-maxNet, Math.min(maxNet, net))), py = y(Number(rec.settle.price));
  const d = `M ${x(-maxNet)} ${y(bidMax)} L ${x(0) - 1} ${y(bid)} M ${x(0) + 1} ${y(ask)} L ${x(maxNet)} ${y(askMax)}`;
  return (
    <figure className="curve">
      <svg viewBox={`-6 -14 ${W + 12} ${H + 34}`} role="img" aria-label="The market maker's committed price curve">
        <line x1={0} x2={W} y1={y(mid)} y2={y(mid)} className="midl" />
        <text x={W} y={y(mid) - 6} textAnchor="end" className="t">pool price {price(c.mid)}</text>
        <path className="path" d={d} />
        <circle className="pdot" cx={px} cy={py} r="5" />
        <text x={0} y={H + 18} className="t">batch sells</text>
        <text x={W} y={H + 18} textAnchor="end" className="t">batch buys</text>
      </svg>
      <figcaption>Locked in block {blockNo(c.block)}. Bid {price(c.bid)} to {price(c.bidMax ?? c.bid)}, ask {price(c.ask)} to {price(c.askMax ?? c.ask)}, up to {eth(c.maxNet, 4)} fETH net. The dot is where the contract set the price.</figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ shell
function Nav({ path }: { path: string }) {
  const { s } = useLive();
  const open = s && s.phase !== "waiting";
  return (
    <nav className="nav">
      <div className="navin">
        <Link to="/" className="brand" aria-label="Blind home"><Logo /></Link>
        <div className="links">
          <Link to="/#how" className="l hideS">How a batch works</Link>
          <Link to="/proof" className={`l ${path.startsWith("/proof") || path.startsWith("/batch") ? "on" : ""}`}>Proof</Link>
          <a href={REPO} target="_blank" rel="noreferrer" className="l hideS">GitHub</a>
        </div>
        <div className="right">
          <span className="live" title="Live batch status">
            <span className={`dot ${open ? "on" : ""}`} />
            <span className="hideS">{s ? (open ? `Batch ${s.batch.id} live` : "Next batch ready") : "Connecting"}</span>
          </span>
          <ThemeToggle />
          {path !== "/app" && <Link to="/app" className="navcta">Open the app</Link>}
        </div>
      </div>
    </nav>
  );
}

function Footer() {
  const { s } = useLive();
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="cols">
          <div className="fbrand">
            <Logo />
            <p>A sealed batch exchange on QoreChain testnet. Test tokens only. They have no value.</p>
          </div>
          <div>
            <h4>Product</h4>
            <Link to="/app">Place a sealed swap</Link>
            <Link to="/proof">Every batch</Link>
            <Link to="/#how">How a batch works</Link>
            <Link to="/#faq">Questions</Link>
          </div>
          <div>
            <h4>Code</h4>
            <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a>
            <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT licence</a>
          </div>
          <div>
            <h4>On chain</h4>
            {s ? <a href={`${EXPLORER}/address/${s.contract}`} target="_blank" rel="noreferrer">Blind contract <span className="mono">{short(s.contract, 6, 4)}</span></a> : <span className="dim">Reading the chain</span>}
            <a href="https://explore.qore.network" target="_blank" rel="noreferrer">QoreChain testnet explorer</a>
          </div>
        </div>
        <div className="base"><span>QoreChain testnet, chain qorechain-diana</span><span>MIT licence</span></div>
      </div>
    </footer>
  );
}

export function Shell({ path, children }: { path: string; children: ReactNode }) {
  const ref = useRef<string>(path);
  useEffect(() => {
    if (ref.current !== path) ref.current = path;
    const h = location.hash.slice(1);
    if (h) setTimeout(() => document.getElementById(h)?.scrollIntoView(), 80);
  }, [path]);
  return (<><Nav path={path} /><main>{children}</main><Footer /></>);
}
