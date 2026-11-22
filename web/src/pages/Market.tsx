// The market side of the trading screen: pair bar, price chart, the sealed order book and the trade tape.
// Everything here reads; nothing signs or sends.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attempt, BatchRec, BotStats, CurrentBatch, Market, State } from "../lib/api";
import { batchPath, clockSkew } from "../lib/api";
import { edgeBps, pct } from "../lib/fmt";
import { Link, Qc, TxLink, agoWords, useNow } from "../ui";

const num = (v: number, dp = 2) => v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
/** Scaled chain price (fUSD per fETH times 1e6) as a number. */
export const px = (scaled: string | bigint) => Number(scaled) / 1e6;
const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function clock(t: number, secs = false) {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}${secs ? `:${two(d.getSeconds())}` : ""}`;
}
function stamp(t: number, secs = false) {
  const d = new Date(t), n = new Date();
  const same = d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
  return same ? clock(t, secs) : `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(t)}`;
}
function spanWords(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
function since(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return stamp(t);
}

/** The server's series, closed with the live pool price so the line always reaches now. */
export function useSeries(m: Market | null, s: State | null, now: number): [number, number][] {
  const live = s ? px(s.pool.mid) : null;
  return useMemo(() => {
    const out = (m?.series ?? []).slice();
    const last = out[out.length - 1];
    const tick = Math.floor(now / 5000) * 5000;
    if (live !== null) {
      if (!last || last[1] !== live) out.push([Math.max(tick, (last?.[0] ?? 0) + 1), live]);
    }
    return out;
  }, [m, live, Math.floor(now / 5000)]);
}

// ------------------------------------------------------------------ pair bar
export function batchStatus(s: State | null, down: boolean, now: number): { text: string; time?: string; on: boolean } {
  if (down) return { text: "Reconnecting to the server", on: false };
  if (!s) return { text: "Reading the chain", on: false };
  switch (s.phase) {
    case "waiting": return { text: "Idle: your swap starts the next batch", on: false };
    case "intake": {
      const left = s.batch.closesAt ? Math.max(0, Math.ceil((s.batch.closesAt - now - clockSkew()) / 1000)) : null;
      return left === null ? { text: "Taking sealed orders", on: true } : { text: "Next settlement in", time: `${Math.floor(left / 60)}:${two(left % 60)}`, on: true };
    }
    case "quoting": return { text: "Locking the price", on: true };
    case "revealing": return { text: "Price locked, orders revealing", on: true };
    case "settling": return { text: "Settling", on: true };
    case "hedging": return { text: "Settled", on: true };
    default: return { text: "", on: false };
  }
}

export function PairBar({ s, down, series, lastBatch }: { s: State | null; down: boolean; series: [number, number][]; lastBatch: BatchRec | null }) {
  // The countdown ticks here, so the rest of the screen does not redraw twice a second.
  const now = useNow(500);
  const last = s ? px(s.pool.mid) : series.length ? series[series.length - 1][1] : null;
  const first = series[0];
  const change = first && last !== null && first[1] > 0 ? ((last - first[1]) / first[1]) * 100 : null;
  const vals = series.map((p) => p[1]);
  const st = batchStatus(s, down, now);
  return (
    <header className="pbar">
      <div className="pb-pair">
        <h1>fETH <span>/</span> fUSD</h1>
        <span className="pb-net">QoreChain testnet</span>
      </div>
      <div className="pb-px">
        <b className="mono">{last !== null ? num(last) : "…"}</b>
        {change !== null && first && now - first[0] > 120_000 && (
          <span className={`pb-ch ${change >= 0 ? "pos" : "neg"}`}><i className="mono">{change >= 0 ? "+" : "−"}{Math.abs(change).toFixed(2)}%</i> in {spanWords(now - first[0])}</span>
        )}
      </div>
      <dl className="pb-stats">
        {vals.length > 1 && <div><dt>High</dt><dd className="mono">{num(Math.max(...vals))}</dd></div>}
        {vals.length > 1 && <div><dt>Low</dt><dd className="mono">{num(Math.min(...vals))}</dd></div>}
        {lastBatch?.settle && <div><dt>Last sealed batch</dt><dd className="mono">{num(px(lastBatch.settle.price))}</dd></div>}
      </dl>
      <div className={`pb-st ${st.on ? "on" : ""}`} role="status" aria-live="polite">
        <span className={`dot ${st.on ? "on" : ""}`} />
        <span>{st.text}{st.time && <> <b className="mono">{st.time}</b></>}</span>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ chart
const RANGES = [["1H", 3_600_000], ["6H", 21_600_000], ["1D", 86_400_000], ["3D", 259_200_000]] as const;
type RangeKey = (typeof RANGES)[number][0];

function niceStep(span: number, n: number) {
  const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

export function PriceChart({ series, batches, now }: { series: [number, number][]; batches: [number, number, number?][]; now: number }) {
  const [range, setRange] = useState<RangeKey>(() => { try { return (localStorage.getItem("blind.range") as RangeKey) || "1D"; } catch { return "1D"; } });
  const pick = (r: RangeKey) => { setRange(r); try { localStorage.setItem("blind.range", r); } catch { /* fine */ } };
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, Math.round(el.clientWidth))));
    ro.observe(el); setW(Math.max(280, Math.round(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const end = Math.floor(now / 5000) * 5000;
  const g = useMemo(() => {
    const H = w < 520 ? 230 : 340, pad = { l: 2, r: 66, t: 14, b: 26 };
    const from = end - RANGES.find((r) => r[0] === range)![1];
    if (!series.length) return null;
    // The level just before the window carries in from its left edge.
    let i0 = -1;
    for (let i = 0; i < series.length; i++) if (series[i][0] <= from) i0 = i; else break;
    const pts: [number, number][] = i0 >= 0 ? [[from, series[i0][1]], ...series.slice(i0 + 1)] : series.slice();
    if (!pts.length) return null;
    const x0 = pts[0][0], x1 = Math.max(end, pts[pts.length - 1][0]);
    if (x1 - x0 < 60_000) return null;
    const dots = batches.filter((b) => b[0] >= x0 && b[0] <= x1);
    const vs = [...pts.map((p) => p[1]), ...dots.map((d) => d[1])];
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < hi * 0.002) { lo -= hi * 0.004; hi += hi * 0.004; }
    const padV = (hi - lo) * 0.14; lo -= padV; hi += padV;
    const x = (t: number) => pad.l + ((t - x0) / (x1 - x0)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    // The pool price only moves when someone trades: a stepped line is the true shape.
    let d = `M ${x(pts[0][0]).toFixed(1)} ${y(pts[0][1]).toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += ` H ${x(pts[i][0]).toFixed(1)} V ${y(pts[i][1]).toFixed(1)}`;
    d += ` H ${x(x1).toFixed(1)}`;
    const area = `${d} V ${H - pad.b} H ${x(x0).toFixed(1)} Z`;
    const step = niceStep(hi - lo, 4);
    const yt: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yt.push(v);
    const n = w < 520 ? 3 : 5;
    const xt = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * (i + 0.5)) / n);
    const long = x1 - x0 > 86_400_000;
    const at = (t: number) => { let v = pts[0][1]; for (const p of pts) { if (p[0] <= t) v = p[1]; else break; } return v; };
    return { H, pad, x, y, d, area, yt, xt, dots, x0, x1, long, at, last: pts[pts.length - 1][1], dp: step < 1 ? 2 : 0 };
  }, [series, batches, range, w, end]);

  const hv = g && hover !== null ? (() => {
    const t = g.x0 + ((hover - g.pad.l) / (w - g.pad.l - g.pad.r)) * (g.x1 - g.x0);
    if (t < g.x0 || t > g.x1) return null;
    const near = g.dots.map((b) => ({ b, dx: Math.abs(g.x(b[0]) - hover) })).sort((a, c) => a.dx - c.dx)[0];
    const dot = near && near.dx < 12 ? near.b : null;
    const tt = dot ? dot[0] : t;
    return { t: tt, v: g.at(tt), dot, cx: g.x(tt) };
  })() : null;

  return (
    <section className="pn-chart" aria-label="Price chart">
      <div className="pnh">
        <div className="legend">
          <span><i className="lg-line" />Public pool price</span>
          <span><i className="lg-dot" />Blind batch price</span>
        </div>
        <div className="rng" role="radiogroup" aria-label="Time range">
          {RANGES.map(([k]) => <button key={k} role="radio" aria-checked={range === k} className={range === k ? "on" : ""} onClick={() => pick(k)}>{k}</button>)}
        </div>
      </div>
      <div className="chart" ref={box}>
        {!g ? (
          <div className="chart-empty" style={{ height: w < 520 ? 230 : 340 }}>
            <p>{series.length ? "Not enough price history in this range yet. The pool is sampled every 30 seconds." : "Reading the pool price."}</p>
          </div>
        ) : (
          <>
            <svg width={w} height={g.H} role="img" aria-label={`fETH price in fUSD on the public pool, with Blind batch prices as dots. Latest ${num(g.last)}.`}
              onPointerMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)} onPointerLeave={() => setHover(null)}>
              <defs>
                <linearGradient id="cfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" className="cf0" /><stop offset="1" className="cf1" /></linearGradient>
              </defs>
              {g.yt.map((v) => <g key={v}><line className="grid" x1={g.pad.l} x2={w - g.pad.r} y1={g.y(v)} y2={g.y(v)} />{Math.abs(g.y(v) - g.y(g.last)) > 16 && <text className="tick" x={w - g.pad.r + 10} y={g.y(v) + 4}>{num(v, g.dp)}</text>}</g>)}
              {g.xt.map((t) => <text key={t} className="tick" textAnchor="middle" x={g.x(t)} y={g.H - 6}>{g.long ? stamp(t) : clock(t)}</text>)}
              <path d={g.area} fill="url(#cfill)" />
              <path d={g.d} className="cline" />
              <line className="lastl" x1={g.pad.l} x2={w - g.pad.r} y1={g.y(g.last)} y2={g.y(g.last)} />
              {g.dots.map((b) => <circle key={b[0]} className="bdot" cx={g.x(b[0])} cy={g.y(b[1])} r={hv?.dot === b ? 6.5 : 4.5} />)}
              {hv && <><line className="cross" x1={hv.cx} x2={hv.cx} y1={g.pad.t} y2={g.H - g.pad.b} /><circle className="cdot" cx={hv.cx} cy={g.y(hv.v)} r="3.5" /></>}
              <g transform={`translate(${w - g.pad.r + 4} ${g.y(g.last)})`}><rect className="lastb" x="0" y="-10" width={g.pad.r - 4} height="20" rx="2" /><text className="lastt" x="6" y="4">{num(g.last)}</text></g>
            </svg>
            {hv && (
              <div className="tip" style={{ left: Math.min(Math.max(hv.cx, 96), w - g.pad.r - 96) }}>
                <span className="mono">{stamp(hv.t, true)}</span>
                <div><i className="lg-line" />Public pool <b className="mono">{num(hv.v)}</b></div>
                {hv.dot && <div><i className="lg-dot" />Blind batch{hv.dot[2] ? ` ${hv.dot[2]}` : ""} <b className="mono">{num(hv.dot[1])}</b></div>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ the sealed order book
function Slats() { return <span className="sl" aria-hidden><i /><i /><i /></span>; }

export function OrderBook({ s, cur, lastBatch, mine }: {
  s: State | null; cur: CurrentBatch | null; lastBatch: BatchRec | null;
  /** The visitor's own sealed orders in this browser: shown even before the server lists them. */
  mine: { postHash: string; bytes: number; at: number; batch: number }[];
}) {
  const active = !!s && s.phase !== "waiting";
  const now = useNow(active ? 1000 : 30_000);
  const id = s?.batch.id;
  const rows = useMemo(() => {
    if (!active) return [];
    const out = (cur && cur.id === id ? cur.posts : []).map((p) => ({ hash: p.hash, bytes: p.bytes, at: p.at, mine: mine.some((m) => m.postHash === p.hash), chain: true }));
    for (const m of mine) if (m.batch === id && !out.some((o) => o.hash === m.postHash)) out.push({ hash: m.postHash, bytes: m.bytes, at: m.at, mine: true, chain: false });
    return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }, [cur, mine, active, id]);
  const commit = active && cur && cur.id === id ? cur.commit : null;
  const opening = s?.phase === "settling" || s?.phase === "hedging";
  const fills = lastBatch?.fills ?? [];
  return (
    <section className="pn-book" aria-label="Order book">
      <div className="pnh"><h2>Order book</h2><span className="pnn">{rows.length ? `${rows.length} sealed` : ""}</span></div>
      <div className="bk-cols"><span>Order</span><span>Size, bytes</span><span>Posted</span></div>
      <div className={`bk-sealed ${opening ? "opening" : ""}`}>
        {rows.map((r) => (
          <div className="bk-row" key={r.hash}>
            <span className={`bk-o ${r.mine ? "mine" : ""}`}><Slats /><b>{r.mine ? "Yours, sealed" : "Sealed"}</b></span>
            <span className="mono">{r.bytes ? r.bytes.toLocaleString("en-US") : "…"}</span>
            <span className="mono dim">{r.at ? since(r.at, now + (r.mine && !r.chain ? 0 : clockSkew())) : "…"}</span>
          </div>
        ))}
        {!rows.length && <p className="bk-empty">{active ? "Reading this batch's sealed orders." : "No sealed orders waiting. Yours starts the next batch."}</p>}
      </div>
      <p className="bk-cap">{rows.length ? "Sealed until the price is locked. No side, no amount, for anyone." : "Orders show here as sealed rows: size in bytes and time, nothing else."}</p>
      <Qc name="QoreSeal">each order is an ML-KEM-1024 + X25519 envelope, read back from its Sealed event on QoreChain EVM</Qc>

      <div className="bk-mid">
        {commit ? (
          <>
            <span>Price locked on chain</span>
            <div><i>Buyers pay from</i><b className="mono">{(Number(commit.ask) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
            <div><i>Sellers get from</i><b className="mono">{(Number(commit.bid) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></div>
          </>
        ) : (
          <>
            <span>{active ? "The market maker locks its price when intake closes" : "Public pool price now"}</span>
            {!active && <b className="mono big">{s ? num(px(s.pool.mid)) : "…"}</b>}
          </>
        )}
      </div>

      {lastBatch?.settle && (
        <>
          <div className="pnh two"><h3>Last batch, opened</h3><span className="pnn">{agoWords(lastBatch.endedAt)}</span></div>
          <div className="bk-cols open"><span>Side</span><span>Size, fETH</span><span>vs public pool</span></div>
          {fills.slice(0, 7).map((f, i) => {
            const e = edgeBps(f);
            return (
              <div className="bk-row open" key={i}>
                <span className={f.buy ? "pos" : "neg"}>{f.buy ? "Buy" : "Sell"}</span>
                <span className="mono">{(Number(f.buy ? f.amountOut : f.amountIn) / 1e18).toFixed(5)}</span>
                <span className={`mono ${e === null ? "dim" : e >= 0 ? "pos" : "neg"}`}>{e === null ? "pool refused" : pct(e)}</span>
              </div>
            );
          })}
          <p className="bk-cap">{fills.length > 7 ? `And ${fills.length - 7} more. ` : ""}All {fills.length === 1 ? "" : `${fills.length} `}filled at one price, {num(px(lastBatch.settle.price))}. <Link to={batchPath(lastBatch)}>See the batch</Link></p>
        </>
      )}
      {!!s?.standingOpen && <p className="bk-cap">{s.standingOpen} limit {s.standingOpen === 1 ? "order is" : "orders are"} waiting, sealed too.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ trades
interface TapeRow { key: string; t: number; pub: boolean; buy: boolean; size: number; price: number; edge: number | null; loss?: number; hash?: string; to?: string }

export function Tape({ live, bot }: { live: BatchRec[] | null; bot: BotStats | null }) {
  const rows = useMemo(() => {
    const out: TapeRow[] = [];
    for (const r of live ?? []) {
      if (!r.settled || !r.settle || !r.endedAt) continue;
      (r.fills ?? []).forEach((f, i) => out.push({
        key: `b${r.batch}.${i}`, t: Date.parse(r.endedAt!), pub: false, buy: f.buy,
        size: Number(f.buy ? f.amountOut : f.amountIn) / 1e18, price: px(r.settle!.price), edge: edgeBps(f), hash: r.settle!.hash, to: batchPath(r),
      }));
    }
    for (const a of (bot?.recent ?? []) as Attempt[]) {
      if (a.order !== "bot first" || !a.victimGot || a.victimLossBps == null) continue;
      const buy = a.side === "buy";
      const eth = Number(buy ? a.victimGot : a.amountIn) / 1e18, usd = Number(buy ? a.amountIn : a.victimGot) / 1e6;
      if (!(eth > 0)) continue;
      out.push({ key: `p${a.victimHash}`, t: Date.parse(a.at), pub: true, buy, size: eth, price: usd / eth, edge: null, loss: a.victimLossBps, hash: a.victimHash });
    }
    return out.sort((a, b) => b.t - a.t).slice(0, 40);
  }, [live, bot]);
  return (
    <section className="pn-tape" aria-label="Trades">
      <div className="pnh"><h2>Trades</h2><span className="pnn">Blind batches and public swaps on the same pool</span></div>
      <div className="tp-cols"><span>Time</span><span>Side</span><span>Size, fETH</span><span>Price</span><span>Result</span></div>
      <div className="tp-rows">
        {rows.map((r) => (
          <div className={`tp-row ${r.pub ? "pub" : ""}`} key={r.key}>
            <span className="mono dim">{stamp(r.t, true)}</span>
            <span className={r.buy ? "pos" : "neg"}>{r.buy ? "Buy" : "Sell"}</span>
            <span className="mono">{r.size.toFixed(5)}</span>
            <span className="mono">{num(r.price)}</span>
            <span className="tp-res">
              {r.pub
                ? <><b className="neg">Public swap, bot took {(r.loss! / 100).toFixed(1)}%</b> <TxLink h={r.hash} label="view" /></>
                : <><b className={r.edge === null ? "dim" : r.edge >= 0 ? "pos" : "neg"}>{r.edge === null ? "Sealed. The pool refused this size" : `Sealed, ${pct(r.edge)} vs public pool`}</b> {r.to && <Link to={r.to} className="txl">batch</Link>}</>}
            </span>
          </div>
        ))}
        {live && !rows.length && <p className="bk-empty">No trades on this contract yet. Yours will be the first.</p>}
        {!live && <p className="bk-empty">Reading recent trades.</p>}
      </div>
    </section>
  );
}
