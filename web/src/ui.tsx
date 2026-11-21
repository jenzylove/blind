import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type MouseEvent } from "react";
import { api, type State, type Phase, type Fill } from "./lib/api";
import { short, pct, edgeBps } from "./lib/fmt";
import { EXPLORER } from "./lib/const";

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
  const sys = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [t, setT] = useState<string>(() => document.documentElement.dataset.theme ?? sys());
  const flip = () => {
    const n = t === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem("blind.theme", n); } catch { /* blocked */ }
    setT(n);
  };
  return (
    <button className="iconbtn" onClick={flip} aria-label={t === "dark" ? "Use light theme" : "Use dark theme"} title={t === "dark" ? "Light" : "Dark"}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" /></svg>
    </button>
  );
}

// ------------------------------------------------------------------ the seal
export function Seal({ open, children, className = "" }: { open: boolean; children: string; className?: string }) {
  return (
    <span className={`seal ${open ? "open" : ""} ${className}`} aria-label={open ? children : "sealed"}>
      <span className="s" aria-hidden>{children}</span>
      <span className="r" aria-hidden={!open}>{children}</span>
    </span>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="2" y="6" width="28" height="20" rx="3" fill="var(--ink)" />
      <path d="M2.8 7.5 16 17 29.2 7.5" fill="none" stroke="var(--bg)" strokeWidth="2" />
      <rect x="7" y="19.5" width="18" height="3.5" rx="1" fill="var(--wax)" />
    </svg>
  );
}

// ------------------------------------------------------------------ phases
export const STEPS = ["Seal", "Post", "Commit", "Reveal", "Settle"] as const;
export function phaseStep(p: Phase): number {
  return { waiting: -1, intake: 1, quoting: 2, opening: 3, settling: 4, hedging: 5 }[p];
}
export function phaseLine(s: State, now: number) {
  switch (s.phase) {
    case "waiting": return "No batch open. The next sealed order opens one.";
    case "intake": {
      const left = s.batch.closesAt ? Math.max(0, Math.ceil((s.batch.closesAt - now) / 1000)) : null;
      return left !== null ? `Batch ${s.batch.id} is taking sealed orders. Closes in ${left} s.` : `Batch ${s.batch.id} is taking sealed orders.`;
    }
    case "quoting": return `Batch ${s.batch.id} is closed. The market maker is committing its price.`;
    case "opening": return `Batch ${s.batch.id}: price is on chain. The batch key is being revealed.`;
    case "settling": return `Batch ${s.batch.id}: orders opened from chain data. Settling at one price.`;
    case "hedging": return `Batch ${s.batch.id} settled. The market maker is rebalancing on x/amm.`;
  }
}

// ------------------------------------------------------------------ bits
export function Edge({ f, scale = 60 }: { f: Fill; scale?: number }) {
  const e = edgeBps(f);
  if (e === null) return <span className="edge mute">x/amm refused this size</span>;
  const w = Math.min(80, Math.max(2, Math.abs(e) * scale / 100));
  return <span className={`edge ${e < 0 ? "neg" : ""}`}><i style={{ width: w }} />{pct(e)}</span>;
}

export function TxLink({ h, label }: { h?: string; label?: string }) {
  if (!h) return null;
  return <a href={`${EXPLORER}/tx/${h.startsWith("0x") ? h : h.toUpperCase()}`} target="_blank" rel="noreferrer" className="mono">{label ?? short(h, 8, 6)}</a>;
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

// ------------------------------------------------------------------ shell
function Nav({ path }: { path: string }) {
  const { s } = useLive();
  const open = s && s.phase !== "waiting";
  return (
    <nav className="nav">
      <Link to="/" className="brand"><Mark /> blind</Link>
      <Link to="/#how" className="l hideS">How it works</Link>
      <Link to="/proof" className={`l ${path.startsWith("/proof") || path.startsWith("/batch") ? "on" : ""}`}>Proof</Link>
      <span className="live" title="Live batch status">
        <span className={`dot ${open ? "on" : ""}`} />
        {s ? (open ? `Batch ${s.batch.id} live` : "Next batch ready") : "Connecting"}
      </span>
      <ThemeToggle />
      {path !== "/app" && <Link to="/app" className="btn wax">Trade</Link>}
    </nav>
  );
}

function Footer() {
  const { s } = useLive();
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="cols">
          <div>
            <div className="brand" style={{ marginBottom: 10 }}><Mark /> blind</div>
            <p className="mute small" style={{ maxWidth: 340, margin: 0 }}>A sealed batch exchange on QoreChain testnet. Test tokens only. They have no value.</p>
          </div>
          <div>
            <h4>Product</h4>
            <Link to="/app">Trade</Link>
            <Link to="/proof">Every batch</Link>
            <Link to="/#how">How a batch works</Link>
            <Link to="/#faq">FAQ</Link>
          </div>
          <div>
            <h4>Code</h4>
            <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub</a>
            <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">MIT licence</a>
          </div>
          <div>
            <h4>On chain</h4>
            {s ? <a href={`${EXPLORER}/address/${s.contract}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 13 }}>Contract {short(s.contract, 6, 4)}</a> : <span className="mute small">Reading the chain</span>}
            <a href="https://explore.qore.network" target="_blank" rel="noreferrer">QoreChain testnet explorer</a>
          </div>
        </div>
        <div className="word" aria-hidden><Seal open={false}>bl</Seal>ind</div>
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
