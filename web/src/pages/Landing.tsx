import { useEffect, useMemo, useRef, useState } from "react";
import { api, batchPath, type BatchRec, type Batches, type BotStats } from "../lib/api";
import { short, blockNo, summarize, pct, inLabel, price, ago } from "../lib/fmt";
import { Link, Edge, usePoll, useReveal, navigate, latestSettled, SlatGlyph, STEPS, attemptIn, attemptOut, AttemptLinks, StepQc, Qc, useLive } from "../ui";
import { viaLinkedKey, COMMIT_PLAIN, txUrl, CONTRACT_URL, RELAY_SRC, LIMIT_SRC, QORESCAN_URL, QCAI_URL, STEP_TECH } from "../lib/qore";
import Blind, { type BlindState } from "../Blind";
import BatchPanel from "../BatchPanel";

export default function Landing() {
  const { v: b } = usePoll(api.batches, 15000);
  const rec = useMemo(() => latestSettled(b), [b]);
  const { v: bot } = usePoll(api.bot, 20000);
  useReveal();
  return (
    <>
      <Hero rec={rec} />
      <Problem rec={rec} bot={bot} />
      <How rec={rec} />
      <Built rec={rec} />
      <ProofSec b={b} />
      <Limits />
      <Faq />
      <section className="closing wrap rv">
        <h2>Your next swap,<br /><em>behind the blinds.</em></h2>
        <div className="ctas">
          <Link to="/app" className="btn day">Place a sealed swap</Link>
          <Link to="/proof" className="btn line">See every batch</Link>
        </div>
        <p className="dim small">No wallet needed. One button makes a test account in this browser.</p>
      </section>
    </>
  );
}

const blindFor = (step: number): BlindState => (step >= 4 ? "open" : step === 3 ? "opening" : "closed");
const hashesOf = (rec: BatchRec) => [undefined, rec.posts?.[0]?.hash ?? rec.create?.hash, rec.commit?.hash, rec.open?.hash, rec.settle?.hash] as (string | undefined)[];
const blocksOf = (rec: BatchRec) => [null, rec.posts?.[0]?.block ?? rec.create!.block, rec.commit!.block, rec.open!.block, rec.settle!.block] as (number | null)[];

// ------------------------------------------------------------------ hero
const T = [0, 1200, 2300, 3400, 5600, 11600, 13000]; // Seal, Post, Commit, Open, Settle, lowering; last = loop
function useReduced() {
  const [r] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  return r;
}
function Hero({ rec }: { rec: BatchRec | null }) {
  const reduced = useReduced();
  const [step, setStep] = useState(reduced ? 4 : 0);
  useEffect(() => {
    if (reduced || !rec) return;
    const start = performance.now();
    const t = setInterval(() => {
      const ms = (performance.now() - start) % T[6];
      setStep(T.findIndex((x, i) => ms >= x && ms < T[i + 1]));
    }, 150);
    return () => clearInterval(t);
  }, [reduced, rec]);
  return (
    <section className="hero">
      <div className="wrap herogrid">
        <div className="herotext">
          <h1>Trade behind the blinds. <span>They open only after the price is locked.</span></h1>
          <p className="sub">Your swap is sealed in your browser, so bots can't see it. The market maker locks its price on chain first. Then the blinds open, and everyone in the batch gets that same price.</p>
          <div className="ctas">
            <Link to="/app" className="btn day">Place a sealed swap</Link>
            {rec && <Link to={batchPath(rec)} className="btn line">Watch batch {rec.batch}</Link>}
          </div>
        </div>
        <div className="herowin" data-step={step}>
          <Blind className="big" state={step === 5 ? "closed" : blindFor(step)} label={rec ? `Batch ${rec.batch}, replayed step by step` : "Latest batch"}>
            <BatchPanel rec={rec} />
          </Blind>
          <ol className="strip" aria-label="Batch steps">
            {STEPS.map((n, i) => (
              <li key={n} className={i === step ? "on" : ""}><span>{n}</span></li>
            ))}
          </ol>
          <p className="cap">{rec ? `Batch ${rec.batch}, settled on QoreChain testnet at block ${blockNo(rec.settle!.block)}. Real data, read live${rec.live ? "" : " (our test traders)"}.` : "Reading the latest batch from QoreChain testnet."}</p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 01 problem
function SecHead({ n, title, lead, id }: { n: string; title: string; lead?: string; id?: string }) {
  return (
    <div className="sechead rv" id={id}>
      <span className="num">{n}</span>
      <h2>{title}</h2>
      {lead && <p className="lead">{lead}</p>}
    </div>
  );
}

function Problem({ rec, bot }: { rec: BatchRec | null; bot: BotStats | null }) {
  const a = bot?.recent.find((x) => x.order === "bot first" && x.victimLossBps != null && x.victimGot && x.victimWouldGet) ?? null;
  const bytes = rec?.posts?.find((p) => p.bytes)?.bytes;
  const lines: [string, string][] = a ? [
    ["A public swap", attemptIn(a)],
    ["The bot bought ahead", a.frontHeight === a.victimHeight ? `same block, ${blockNo(a.victimHeight)}` : `block ${blockNo(a.frontHeight)}`],
    ["The swapper got", attemptOut(a, a.victimGot!)],
    ["Without the bot", attemptOut(a, a.victimWouldGet!)],
    ["Lost to the bot", `${(a.victimLossBps! / 100).toFixed(2)}%`],
  ] : [];
  const rows = (
    <div className="ord">
      {a ? lines.map(([k, v]) => <div key={k}><span>{k}</span><b>{v}</b></div>)
        : <div><span>{bot ? "No attack recorded yet. Send a public swap from the app and it lands here." : "Reading the bot's latest attack"}</span></div>}
    </div>
  );
  return (
    <section className="sec wrap" id="problem">
      <SecHead n="01" title="On a normal chain, your swap is public before it lands" lead="A bot reads its size and direction while it waits, buys first, and sells right after you. We run one on QoreChain testnet against every public swap on our pool. This is its latest real attack." />
      <div className="pair rv">
        <div className="pairrow">
          <p className="pk">What the bot did to a public swap{a ? `, ${ago(a.at)}` : ""}</p>
          <Blind state="open" flat className="small">{rows}</Blind>
          {a && <p className="pn"><AttemptLinks a={a} /> <Link to="/proof#bot">The bot's full record</Link></p>}
        </div>
        <div className="pairrow">
          <p className="pk">What the same bot reads on Blind</p>
          <Blind state="closed" flat className="small">{rows}</Blind>
          <p className="pn">{bytes ? `${bytes.toLocaleString("en-US")} bytes of sealed data on chain. ` : ""}No side, no amount, nothing to get ahead of.</p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 02 how
const HOW = [
  { n: "Seal", p: "Your order is signed and locked in your browser to this batch's public key. Nothing readable leaves the page." },
  { n: "Post", p: "The sealed order lands on chain. Anyone can see that an order exists. Nobody can see its side, size or limit." },
  { n: "Commit price", p: "Intake closes. The market maker prices from public data only and locks a signed price curve on chain." },
  { n: "Open", p: "In a later block the batch key is revealed. The contract checks it against the promise made when the batch opened, and every order is opened from chain data." },
  { n: "Settle", p: "One transaction. The contract sets one price on the locked curve, checks every signature, and pays everyone at that price." },
];

function How({ rec }: { rec: BatchRec | null }) {
  const [on, setOn] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) setOn(Number((e.target as HTMLElement).dataset.i)); }), { rootMargin: "-45% 0px -50% 0px" });
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);
  const bl = rec ? blocksOf(rec) : null;
  const hs = rec ? hashesOf(rec) : null;
  const bytes = rec?.posts?.find((p) => p.bytes)?.bytes;
  return (
    <section className="sec wrap" id="how">
      <SecHead n="02" title="How a batch works" lead={rec ? `Five steps, played with the real blocks of batch ${rec.batch}. The price is on chain before any order can be read.` : "Five steps. The price is on chain before any order can be read."} />
      <div className="how">
        <div className="howwin">
          <Blind state={blindFor(on)} label="The batch at this step"><BatchPanel rec={rec} /></Blind>
          <p className="cap">{bl ? (on === 0 ? "Step 1 happens in your browser, before any block." : `Step ${on + 1}, block ${blockNo(bl[on]!)}.`) : ""}{bl && on === 4 ? ` From the first order to settlement: ${bl[4]! - bl[1]!} blocks.` : ""}</p>
        </div>
        <ol className="steps">
          {HOW.map((s, i) => (
            <li key={s.n} data-i={i} ref={(r) => { refs.current[i] = r; }} className={i === on ? "on" : i < on ? "done" : ""}>
              <div className="k"><span>{String(i + 1).padStart(2, "0")}</span><span>{bl ? (bl[i] ? `block ${blockNo(bl[i]!)}` : "in your browser") : ""}</span></div>
              <h3>{s.n}</h3>
              <p>{s.p}</p>
              {i === 2 && rec && !viaLinkedKey(rec.commit?.hash)
                ? <Qc name={COMMIT_PLAIN.name} href={hs?.[2] ? txUrl(hs[2]!) : undefined} link={`batch ${rec.batch}, this step`}>{COMMIT_PLAIN.rest}</Qc>
                : <StepQc i={i} href={hs?.[i] ? txUrl(hs[i]!) : undefined} link={rec ? `batch ${rec.batch}, this step` : undefined}>
                  {i === 0 && bytes ? `${STEP_TECH[0].rest}. ${bytes.toLocaleString("en-US")} bytes per order` : undefined}
                </StepQc>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 03 built on QoreChain
interface Row { name: string; what: string; use: string; href: string; link: string }
function Built({ rec }: { rec: BatchRec | null }) {
  const { s } = useLive();
  const tx = (h: string | undefined, fallback: string) => (h ? txUrl(h) : fallback);
  const rows: Row[] = [
    { name: "ML-DSA-87 accounts and precompiles", what: "Post quantum keys held on chain", use: "Every test account registers its ML-DSA-87 key with proof of possession (MsgRegisterPQCKeyV2) and hybrid signs everything after. At settlement BlindSettlement checks each order's signature through pqcVerify (0x0A01) against the key pqcKeyStatus (0x0A02) reports.", href: tx(rec?.settle?.hash, CONTRACT_URL), link: rec ? `Settlement of batch ${rec.batch}` : "The contract" },
    { name: "QoreSeal", what: "Hybrid post quantum sealed envelopes", use: "Seals every order in your browser: ML-KEM-1024 + X25519, 6,648 bytes each, so a bot reading the chain learns nothing.", href: tx(rec?.posts?.[0]?.hash, CONTRACT_URL), link: rec ? `A sealed order in batch ${rec.batch}` : "The contract" },
    { name: "Scoped EVM windows", what: "Limits on what EVM keys do", use: "Your test account opens a window for two approvals, to fUSD and fETH only. The operator posts, reveals and settles inside its own window: 300 transactions, 3,000 blocks, BlindSettlement only.", href: CONTRACT_URL, link: "BlindSettlement on QoreChain EVM" },
    { name: "Account abstraction spending rule", what: "Linked keys with chain enforced limits", use: "The market maker agent commits prices with its own ed25519 key linked to the operator account. The chain lets it call commit on Blind and nothing else, 1 uqor per call and per day, for 29 days.", href: "/proof#agent", link: "The live rule" },
    { name: "QoreSign", what: "Hybrid signature checks before broadcast", use: "The relayer checks both halves of every transaction your browser sends, including ML-DSA-87 against the key registered on chain, before it broadcasts.", href: RELAY_SRC, link: "The relay check" },
    { name: "x/amm", what: "QoreChain's built in exchange", use: "The agent rebalances on pool 3 (fETH/fUSD) from a separate account. Every fill is compared with it, and the public lane swaps on it while our bot reads the public mempool.", href: tx(rec?.hedge?.hash, "/proof#bot"), link: rec?.hedge?.hash ? `Rebalance after batch ${rec.batch}` : "The bot's record" },
    { name: "@qorechain/pqc", what: "ML-DSA-87 in plain JavaScript", use: "Checks a limit order's signature the moment it arrives, before it waits for a batch.", href: LIMIT_SRC, link: "Where it runs" },
    { name: "QoreScan", what: "Cryptography inventory of a project", use: "A CBOM of Blind's accounts, live site and contract: what is post quantum, and what is not.", href: QORESCAN_URL, link: "The scan" },
    { name: "QCAI audit", what: "QoreChain's AI contract auditor", use: "Reviewed BlindSettlement. Our answer to each finding points at a test that proves it.", href: QCAI_URL, link: "The answers" },
    { name: "Faucet tokens", what: "Test fUSD and fETH", use: "The relayer funds each test account and converts bank coins into ERC-20 tokens with MsgConvertCoin.", href: s ? `https://explore.qore.network/address/${s.tokens.fUSD.address}` : CONTRACT_URL, link: s ? "fUSD token" : "The contract" },
  ];
  return (
    <section className="sec wrap" id="qorechain">
      <SecHead n="03" title="Built on QoreChain" lead="Each piece of QoreChain that does real work in Blind, in order of how much rests on it." />
      <ol className="built rv">
        {rows.map((r, i) => {
          const ext = !r.href.startsWith("/proof");
          return (
            <li key={r.name}>
              <span className="bi">{String(i + 1).padStart(2, "0")}</span>
              <div className="bt"><b>{r.name}</b><span>{r.what}</span></div>
              <p>{r.use}</p>
              {ext ? <a className="bl" href={r.href} target="_blank" rel="noreferrer">{r.link} <span aria-hidden>↗</span></a> : <Link className="bl" to={r.href}>{r.link}</Link>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ 04 proof
function ProofSec({ b }: { b: Batches | null }) {
  const all = b ? [...b.live, ...b.testRuns].sort((x, y) => y.batch - x.batch) : [];
  const s = summarize(all);
  return (
    <section className="sec wrap" id="proof">
      <SecHead n="04" title="The proof, batch by batch" lead="Every fill next to what QoreChain's own exchange (x/amm) would have paid for the same input, one block before settlement. Misses stay in." />
      <div className="rv">
        <div className="figs">
          <div><b>{b ? s.batches : "…"}</b><span>batches settled</span></div>
          <div><b>{b ? `${s.better} of ${s.compared}` : "…"}</b><span>fills beat x/amm</span></div>
          <div><b>{b && s.avgBps !== null ? pct(s.avgBps) : "…"}</b><span>average per fill vs x/amm</span></div>
          <div><b>{b && s.markoutUsd !== null ? `${s.markoutUsd >= 0 ? "+" : "−"}${Math.abs(s.markoutUsd).toFixed(2)}` : "…"}</b><span>market maker result in fUSD, 30 blocks later</span></div>
        </div>
        <div className="rows">
          {all.filter((r) => r.settled).slice(0, 6).map((r) => (
            <a key={`${r.live ? "l" : "t"}${r.version ?? 2}-${r.batch}`} href={batchPath(r)} className="brow" onClick={(e) => { e.preventDefault(); navigate(batchPath(r)); }}>
              <SlatGlyph state="open" />
              <span className="bn">Batch {r.batch}</span>
              <span className="who">{r.live ? "from the app" : "test traders (our accounts)"}</span>
              <span className="fills">{r.fills?.map((f, i) => <span key={i}><small>{f.buy ? "buy" : "sell"}</small> <Edge f={f} /></span>)}</span>
              <span className="px mono">{price(r.settle!.price)}</span>
              <span className="when">{r.live ? ago(r.endedAt) : `block ${blockNo(r.settle!.block)}`}</span>
            </a>
          ))}
          {!b && <div className="empty">Reading batches from the server.</div>}
        </div>
        <Link to="/proof" className="btn line">Every batch, with block numbers</Link>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 04 limits
function Limits() {
  return (
    <section className="sec wrap" id="limits">
      <SecHead n="05" title="What the chain checks, and what it does not" lead="Sealing stops bots from reading your order, and the market maker locks its price before any order opens. It does not remove every party you trust." />
      <div className="limits rv">
        <div className="lit">
          <h3>In daylight: the chain checks</h3>
          <ul>
            <li><b>The price came first.</b> The market maker's curve is on chain, signed, before the batch key is revealed.</li>
            <li><b>The key is the one promised.</b> Its fingerprint is fixed on chain when the batch opens.</li>
            <li><b>The contract sets the price,</b> not the operator, from the locked curve and the orders.</li>
            <li><b>Every order is yours.</b> Each carries your post quantum signature, checked against the key QoreChain holds for your account.</li>
            <li><b>Your limit holds.</b> Nobody is filled below the minimum they signed.</li>
            <li><b>The agent is on a leash.</b> Its key is linked to the operator account with a spending rule the chain enforces: the only call it can make is committing a price curve to Blind, and it can move at most 1 uqor a day.</li>
          </ul>
        </div>
        <div className="shade">
          <h3>In the shade: you trust the operator for</h3>
          <ul>
            <li><b>Not peeking.</b> The operator holds the batch key, so it could read orders before the reveal. The chain proves the price was fixed before the reveal and that the contract computed it.</li>
            <li><b>One service, two roles.</b> Today the operator and the market maker run as one service. So the promise that the market maker cannot price against your order rests on the operator not peeking.</li>
            <li><b>Limit orders.</b> They are sealed to a standing key the operator can read, so they can wait across batches.</li>
            <li><b>Including you.</b> The operator picks which posted orders go to settlement. Left out orders are listed with the reason, and anyone can open every order after the reveal.</li>
            <li><b>Price when alone.</b> Trading alone you pay about what x/amm charges plus 0.15%. When buyers and sellers meet in a batch, the lighter side gets a much better price than x/amm and the heavier side pays about the market maker's price for the rest.</li>
            <li><b>Testnet.</b> fUSD, fETH and QOR here are test tokens with no value.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 05 faq
const QA: [string, string][] = [
  ["Do I need a wallet?", "No. One button makes a test account in this browser, registers its post quantum key and funds it with test QOR, fUSD and fETH. The recovery words stay in this browser."],
  ["What does post quantum mean here?", "Signatures use ML-DSA-87 and sealing uses ML-KEM-1024, the NIST standards FIPS 204 and FIPS 203, built to hold against quantum computers. QoreChain stores each account's signing key, and the Blind contract checks your order against it."],
  ["Why a batch instead of a normal swap?", "Orders that arrive together are opened together and paid one price. There is no first in line to jump, so there is nothing to front run. Buyers and sellers in the same batch also meet each other directly, which beats paying the pool on both sides."],
  ["Who is the market maker?", "An AI agent with its own post quantum key. It sees only public data when it prices: the x/amm pool, its own stock and recent moves. After settlement it rebalances on x/amm from a separate account."],
  ["What if the price passes my limit?", "Your order is left out of that batch with the reason recorded, and nothing leaves your account. You choose the limit before sealing; 4% from the pool price is the default."],
  ["What is x/amm?", "QoreChain's built in exchange, a constant product pool. Every Blind fill is compared with what x/amm would have paid for the same input at the block before settlement."],
];
function Faq() {
  return (
    <section className="sec wrap" id="faq">
      <SecHead n="06" title="Questions" />
      <div className="faq rv">
        {QA.map(([q, a], i) => (
          <details className="qa" key={q} open={i === 0} {...{ name: "faq" }}><summary>{q}</summary><div className="a">{a}</div></details>
        ))}
      </div>
    </section>
  );
}
