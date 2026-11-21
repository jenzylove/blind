import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BatchRec, type Batches } from "../lib/api";
import { eth, price, short, blockNo, summarize, pct, inLabel, outLabel, ago } from "../lib/fmt";
import { Link, Seal, Edge, usePoll, useReveal, navigate } from "../ui";

/** The most recent settled batch with the most fills, live first. */
function latest(b: Batches | null): BatchRec | null {
  if (!b) return null;
  const pick = (rs: BatchRec[]) => rs.filter((r) => r.settled && r.fills?.length && r.commit && r.open && r.create);
  const lv = pick(b.live), t = pick(b.testRuns).reverse();
  const two = [...lv, ...t].find((r) => (r.fills?.length ?? 0) >= 2);
  return two ?? lv[0] ?? t[0] ?? null;
}

export default function Landing() {
  const { v: b } = usePoll(api.batches, 15000);
  const rec = useMemo(() => latest(b), [b]);
  useReveal();
  return (
    <>
      <Hero rec={rec} />
      <Problem rec={rec} />
      <How rec={rec} />
      <ProofSec b={b} />
      <Limits />
      <Faq />
      <section className="closing wrap">
        <h2 className="rv">Your next swap,<br />sealed.</h2>
        <div className="ctas" style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Link to="/app" className="btn wax">Place a sealed swap</Link>
          <Link to="/proof" className="btn">See every batch</Link>
        </div>
        <p className="mute small" style={{ marginTop: 18 }}>No wallet needed. One button makes a test account in this browser.</p>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ hero
const T = [0, 2600, 5000, 7800, 10600, 15800]; // step starts (ms), last = loop
function Hero({ rec }: { rec: BatchRec | null }) {
  const [t, setT] = useState(0);
  const [pill, setPill] = useState(false);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => { setT((performance.now() - start) % T[5]); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const p = setInterval(() => setPill((x) => !x), 2600);
    return () => { cancelAnimationFrame(raf); clearInterval(p); };
  }, []);
  const step = T.findIndex((x, i) => t >= x && t < T[i + 1]);
  return (
    <section className="hero">
      <div className="wrap">
        <h1>Trade without<br />being <span className="pill"><Seal open={pill}>seen</Seal></span></h1>
        <p className="sub">Blind is a sealed batch exchange on QoreChain. Your swap is locked in your browser with post quantum keys. The price is fixed on chain before anyone can open it, and the whole batch settles at one price.</p>
        <div className="ctas">
          <Link to="/app" className="btn wax">Place a sealed swap</Link>
          <Link to="/#how" className="btn">How a batch works</Link>
        </div>
        <p className="fact">On public chains, bots read pending swaps and pay higher fees to trade ahead of them. <cite>Daian et al., “Flash Boys 2.0”, IEEE Symposium on Security and Privacy, 2020.</cite></p>
      </div>
      <Replay rec={rec} t={t} step={step} />
    </section>
  );
}

function useTicker(target: number | undefined, ms = 900) {
  const [v, setV] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  useEffect(() => {
    if (target == null) return;
    const a = from.current || target - 3, b = target, s = performance.now();
    let raf = 0;
    const f = () => {
      const k = Math.min(1, (performance.now() - s) / ms);
      setV(Math.round(a + (b - a) * k));
      if (k < 1) raf = requestAnimationFrame(f); else from.current = b;
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

const WHAT = [
  "Orders are signed and sealed in each trader's browser",
  "Sealed envelopes land on chain. Nobody can read them",
  "The market maker commits its price curve, signed",
  "The batch key is revealed in a later block",
  "One transaction settles every order at one price",
];

function Replay({ rec, t, step }: { rec: BatchRec | null; t: number; step: number }) {
  const blocks = rec ? [rec.create!.block, rec.posts?.[rec.posts.length - 1]?.block ?? rec.create!.block, rec.commit!.block, rec.open!.block, rec.settle!.block] : [];
  const shown = useTicker(rec ? blocks[Math.max(0, step)] : undefined);
  const fills = rec?.fills ?? [];
  const opened = (i: number) => step > 3 || (step === 3 && t - T[3] > 500 + i * 450);
  return (
    <div className="replay" aria-label="A replay of the latest real batch">
      <div className="grid wrap">
        <div className="clock">
          <div>
            <div className="lbl">{rec ? `Batch ${rec.batch}, ${rec.live ? "live" : "test traders"}` : "Latest batch"}</div>
            <div className="bn">{rec ? `#${blockNo(shown)}` : "Reading chain"}</div>
            <div className="lbl">QoreChain block</div>
          </div>
          <div className="what">{WHAT[Math.max(0, step)]}</div>
        </div>
        <div className="rows">
          {fills.map((f, i) => (
            <div className="rrow" key={i}>
              <span className="side">{f.buy ? "Buy" : "Sell"}</span>
              <Seal open={opened(i)}>{inLabel(f)}</Seal>
              <Seal open={opened(i)}>{outLabel(f)}</Seal>
              <span className={`vs ${step >= 4 ? "show" : ""}`}><Edge f={f} /></span>
            </div>
          ))}
          {!rec && <div className="empty">Loading the latest batch from the chain.</div>}
          {rec && <div className={`priceline ${step >= 4 ? "on" : ""}`}><span>one price {price(rec.settle!.price)} fUSD per fETH</span></div>}
        </div>
        <Curve rec={rec} on={step >= 2} dot={step >= 4} />
      </div>
      <div className="steps5 wrap">
        {["Seal", "Post", "Commit", "Reveal", "Settle"].map((n, i) => (
          <div key={n} className={i < step ? "done" : i === step ? "on" : ""} style={{ ["--dur" as any]: `${(T[i + 1] - T[i]) / 1000}s` }}>
            <b>{i + 1}</b>{n}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Curve({ rec, on, dot }: { rec: BatchRec | null; on: boolean; dot: boolean }) {
  if (!rec?.commit) return <div className="curve" />;
  const c = rec.commit;
  const bid = Number(c.bid), ask = Number(c.ask);
  const bidMax = Number(c.bidMax ?? c.bid), askMax = Number(c.askMax ?? c.ask), mid = Number(c.mid);
  const lo = Math.min(bidMax, Number(rec.settle!.price)) * 0.999, hi = Math.max(askMax, Number(rec.settle!.price)) * 1.001;
  const W = 240, H = 160;
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const maxNet = Number(c.maxNet);
  const x = (n: number) => W / 2 + (n / maxNet) * (W / 2);
  const net = -Number(rec.settle!.makerBase);
  const px = x(Math.max(-maxNet, Math.min(maxNet, net))), py = y(Number(rec.settle!.price));
  const d = `M ${x(-maxNet)} ${y(bidMax)} L ${x(0) - 1} ${y(bid)} M ${x(0) + 1} ${y(ask)} L ${x(maxNet)} ${y(askMax)}`;
  return (
    <div className={`curve ${on ? "on" : ""}`}>
      <div className="lbl small mute" style={{ textTransform: "uppercase", letterSpacing: ".08em", fontSize: 12 }}>Committed curve, block {blockNo(c.block)}</div>
      <svg viewBox={`-6 -14 ${W + 12} ${H + 34}`} role="img" aria-label="The market maker's committed price curve">
        <line x1={0} x2={W} y1={y(mid)} y2={y(mid)} stroke="var(--line)" strokeDasharray="3 4" />
        <text x={W} y={y(mid) - 5} textAnchor="end" fontSize="10" fill="var(--mute)" fontFamily="var(--mono)">pool mid {price(c.mid)}</text>
        <path className="area" d={`M ${x(0) + 1} ${y(ask)} L ${x(maxNet)} ${y(askMax)} L ${x(maxNet)} ${H} L ${x(0) + 1} ${H} Z`} />
        <path className="path" d={d} />
        <circle className={`pdot ${dot ? "on" : ""}`} cx={px} cy={py} r="5" />
        <text x={0} y={H + 16} fontSize="10" fill="var(--mute)" fontFamily="var(--mono)">batch sells</text>
        <text x={W} y={H + 16} textAnchor="end" fontSize="10" fill="var(--mute)" fontFamily="var(--mono)">batch buys</text>
      </svg>
      <div className="small mute">Bid {price(c.bid)} to {price(c.bidMax ?? c.bid)}. Ask {price(c.ask)} to {price(c.askMax ?? c.ask)}. Up to {eth(c.maxNet, 4)} fETH net.</div>
    </div>
  );
}

// ------------------------------------------------------------------ 01 problem
function SecHead({ n, title, lead, id }: { n: string; title: string; lead?: string; id?: string }) {
  return (
    <div className="sechead rv" id={id}>
      <div className="num">{n}</div>
      <div><h2>{title}</h2>{lead && <p className="lead">{lead}</p>}</div>
    </div>
  );
}

function Problem({ rec }: { rec: BatchRec | null }) {
  const f = rec?.fills?.[0];
  const bytes = rec?.posts?.find((p) => p.bytes)?.bytes;
  const lines = f ? [`${f.buy ? "buy fETH with" : "sell"} ${inLabel(f)}`, `from ${short(f.user, 6, 4)}`, `block ${blockNo(rec!.posts?.[0]?.block)}`] : [];
  return (
    <section className="sec wrap" id="problem">
      <SecHead n="01" title="Your swap is public before it lands" lead="On a normal chain a pending swap sits in plain view. A bot reads its size and direction, trades first, and sells back to you at a worse price. You never see it happen; you just get less." />
      <div className="body rv">
        <div className="views">
          <div>
            <h3>What a bot reads on a public chain</h3>
            {f ? lines.map((l) => <div className="line" key={l}>{l}</div>) : <div className="line mute">Loading a real order</div>}
            <p>Side, size and sender are all readable while the swap waits. That is everything a front runner needs.</p>
          </div>
          <div>
            <h3>What anyone reads on Blind</h3>
            {f ? lines.map((l, i) => <div className="line" key={l}>{i < 2 ? <Seal open={false}>{l}</Seal> : l}</div>) : <div className="line mute">Loading a real order</div>}
            <p>The same order, as it sits on chain{bytes ? `: ${bytes.toLocaleString("en-US")} bytes of ciphertext` : ""}. Nothing about it can be read until the market maker's price is already fixed.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 02 how
const HOW = [
  { n: "Seal", where: "in your browser", p: "Your order is signed with your own ML-DSA-87 key and locked with ML-KEM-1024 to this batch's public key. Nothing readable leaves the page." },
  { n: "Post", where: "on chain", p: "The sealed envelope is posted to the Blind contract. Anyone can see that an order exists. Nobody can see its side, size or limit." },
  { n: "Commit", where: "on chain", p: "Intake closes. The AI market maker prices from public data only (pool reserves, its own stock, recent moves) and commits a price curve, signed with its own ML-DSA-87 key." },
  { n: "Reveal", where: "a later block", p: "Strictly after the commit block, the batch key is revealed. The contract checks it against the hash fixed when the batch opened. Every envelope is opened from chain data." },
  { n: "Settle", where: "one transaction", p: "The contract computes one clearing price on the committed curve, checks every order's signature against the key QoreChain holds for that trader, and pays everyone at that price." },
];

function How({ rec }: { rec: BatchRec | null }) {
  const [on, setOn] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setOn(Number((e.target as HTMLElement).dataset.i)); }), { rootMargin: "-45% 0px -50% 0px" });
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);
  const bl = rec ? [rec.create!.block, rec.posts?.[0]?.block ?? rec.create!.block, rec.commit!.block, rec.open!.block, rec.settle!.block] : null;
  const lo = bl ? bl[0] - 1 : 0, hi = bl ? bl[4] + 1 : 1;
  const xp = (b: number) => `${((b - lo) / (hi - lo)) * 100}%`;
  return (
    <section className="sec wrap" id="how">
      <SecHead n="02" title="How a batch works" lead={rec ? `Five steps, played with the block numbers of batch ${rec.batch}. The price is on chain before any order can be opened.` : "Five steps. The price is on chain before any order can be opened."} />
      <div className="body how">
        <div className="ruler">
          <div className="track">
            {bl && Array.from({ length: hi - lo + 1 }, (_, i) => <span key={i} className="tick" style={{ left: xp(lo + i) }} />)}
            {bl && bl.map((b, i) => (
              <div key={i} className={`mk ${i <= on ? "on" : ""} ${i === on ? "cur" : ""}`} style={{ left: xp(b) }}>
                <span className="t">{i + 1}</span>
                <span className="bar" style={{ height: i <= on ? 34 + i * 12 : 10 }} />
              </div>
            ))}
          </div>
          <div className="axis">{bl ? <><span>block {blockNo(lo)}</span><span>block {blockNo(hi)}</span></> : <span>Reading the latest batch</span>}</div>
          {bl && <div className="note"><b>{HOW[on].n}</b>{on === 0 ? `: batch opened in block ${blockNo(bl[0])}, sealed orders followed.` : ` in block ${blockNo(bl[on])}.`} From the first order to settlement took {bl[4] - bl[0]} blocks.</div>}
        </div>
        <ol className="stepsv">
          {HOW.map((s, i) => (
            <li key={s.n} data-i={i} ref={(r) => { refs.current[i] = r; }} className={i <= on ? "on" : ""}>
              <div className="k"><span>{String(i + 1).padStart(2, "0")}</span><span>{bl ? (i === 0 ? s.where : `block ${blockNo(bl[i])}`) : s.where}</span></div>
              <h3>{s.n}</h3>
              <p>{s.p}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 03 proof
function ProofSec({ b }: { b: Batches | null }) {
  const all = b ? [...b.live, ...[...b.testRuns].reverse()] : [];
  const s = summarize(all);
  return (
    <section className="sec wrap" id="proof">
      <SecHead n="03" title="The proof, batch by batch" lead="Every fill next to what QoreChain's own exchange (x/amm) would have paid for the same input, one block before settlement. Misses stay in." />
      <div className="body rv">
        <div className="figs">
          <div><div className="v">{b ? s.batches : "…"}</div><div className="k">batches settled on the current contract</div></div>
          <div><div className="v">{b ? `${s.better} of ${s.compared}` : "…"}</div><div className="k">fills beat x/amm</div></div>
          <div><div className="v">{b && s.avgBps !== null ? pct(s.avgBps) : "…"}</div><div className="k">average vs x/amm per fill</div></div>
          <div><div className="v">{b && s.markoutUsd !== null ? `${s.markoutUsd >= 0 ? "+" : "−"}${Math.abs(s.markoutUsd).toFixed(2)}` : "…"}</div><div className="k">market maker result in fUSD, 30 blocks later</div></div>
        </div>
        <table className="tbl resp">
          <thead><tr><th>Batch</th><th>Who</th><th>Fills vs x/amm</th><th>One price</th><th>Settled</th></tr></thead>
          <tbody>
            {all.filter((r) => r.settled).slice(0, 6).map((r) => (
              <tr key={`${r.live ? "l" : "t"}${r.batch}`} className="click" onClick={() => navigate(`/batch/${r.batch}`)}>
                <td data-k="Batch" className="mono">{r.batch}</td>
                <td data-k="Who">{r.live ? <span className="tag wax">app</span> : <span className="tag">test traders (our accounts)</span>}</td>
                <td data-k="Fills"><div style={{ display: "grid", gap: 4, justifyItems: "end" }}>{r.fills?.map((f, i) => <span key={i}><span className="mute small">{f.buy ? "buy " : "sell "}</span><Edge f={f} /></span>)}</div></td>
                <td data-k="Price" className="mono">{price(r.settle!.price)}</td>
                <td data-k="Settled" className="mute small">{r.live ? ago(r.endedAt) : `block ${blockNo(r.settle!.block)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!b && <div className="empty">Reading batches from the server.</div>}
        <div style={{ marginTop: 24 }}><Link to="/proof" className="btn">Every batch, with block numbers</Link></div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 04 limits
function Limits() {
  return (
    <section className="sec wrap" id="limits">
      <SecHead n="04" title="What the chain checks, and what it does not" lead="Sealing stops bots and the market maker from reading your order. It does not remove every party you trust. Here is the line." />
      <div className="body rv">
        <div className="limits">
          <div>
            <h3>The chain checks</h3>
            <ul>
              <li><b>The price came first.</b> The market maker's curve is on chain, signed with its post quantum key, before the batch key is revealed.</li>
              <li><b>The key is the one promised.</b> Its hash is fixed on chain when the batch opens.</li>
              <li><b>The contract sets the price,</b> not the operator, from the committed curve and the orders.</li>
              <li><b>Every order is yours.</b> Each carries your ML-DSA-87 signature, checked against the key QoreChain holds for your account.</li>
              <li><b>Your limit holds.</b> Nobody is filled below the minimum they signed.</li>
            </ul>
          </div>
          <div className="no">
            <h3>You trust the operator for</h3>
            <ul>
              <li><b>Not peeking.</b> The operator holds the batch key, so it could read orders before the reveal. The chain proves the price was fixed before the reveal and that the contract computed it.</li>
              <li><b>Limit orders.</b> They are sealed to a standing key the operator can read, so they can wait across batches.</li>
              <li><b>Including you.</b> The operator picks which posted orders go to settlement. Left out orders are listed with the reason, and every envelope can be opened by anyone after the reveal.</li>
              <li><b>Price when alone.</b> Trading alone you pay about what x/amm charges plus 0.15%. When buyers and sellers meet in a batch, both do better than x/amm.</li>
              <li><b>Testnet.</b> fUSD, fETH and QOR here are test tokens with no value.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 05 faq
const QA: [string, string][] = [
  ["Do I need a wallet?", "No. One button makes a test account in this browser, registers its post quantum key and funds it with test QOR, fUSD and fETH. The recovery words stay in this browser."],
  ["What does post quantum mean here?", "Signatures use ML-DSA-87 and sealing uses ML-KEM-1024, the NIST standards FIPS 204 and FIPS 203, built to hold against quantum computers. QoreChain stores each account's ML-DSA-87 key, and the Blind contract checks your order against it."],
  ["Why a batch instead of a normal swap?", "Orders that arrive together are opened together and paid one price. There is no first in line to jump, so there is nothing to front run. Buyers and sellers in the same batch also meet each other directly, which beats paying the pool on both sides."],
  ["Who is the market maker?", "An AI agent with its own post quantum key. It sees only public data when it prices: the x/amm pool, its own stock and recent moves. After settlement it rebalances on x/amm from a separate account."],
  ["What if the price passes my limit?", "Your order is left out of that batch with the reason recorded, and nothing leaves your account. You choose the limit before sealing; 4% from the pool price is the default."],
  ["What is x/amm?", "QoreChain's built in exchange, a constant product pool. Every Blind fill is compared with what x/amm would have paid for the same input at the block before settlement."],
];
function Faq() {
  return (
    <section className="sec wrap" id="faq">
      <SecHead n="05" title="Questions" />
      <div className="body rv">
        {QA.map(([q, a], i) => (
          <details className="qa" key={q} open={i === 0}><summary>{q}</summary><div className="a">{a}</div></details>
        ))}
      </div>
    </section>
  );
}

