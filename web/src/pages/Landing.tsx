import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BatchRec, type Batches, type BotStats, type Attempt, type Envelope } from "../lib/api";
import { summarize, pct, inLabel, outLabel, price } from "../lib/fmt";
import { Link, Edge, usePoll, useReveal, latestSettled, attemptOut } from "../ui";
import { txUrl } from "../lib/qore";
import Blind, { type BlindState } from "../Blind";

export default function Landing() {
  const { v: b } = usePoll(api.batches, 15000);
  const { v: bot } = usePoll(api.bot, 20000);
  const { v: env, err: envErr } = usePoll(api.envelope, 60000);
  const rec = useMemo(() => heroRec(b), [b]);
  useReveal();
  return (
    <>
      <Hero rec={rec} />
      <Problem bot={bot} env={env} envMissing={envErr && !env} />
      <How />
      <Record b={b} bot={bot} />
      <Faq />
    </>
  );
}

/** The newest settled swap from the app, else the newest settled batch at all. */
function heroRec(b: Batches | null): BatchRec | null {
  const app = b?.live.find((r) => r.settled && r.fills?.length && r.endedAt);
  return app ?? latestSettled(b);
}

/** "4 minutes ago", in words. */
function agoWords(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const n = (v: number, u: string) => `${v} ${u}${v === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return n(Math.round(s / 60), "minute");
  if (s < 86400) return n(Math.round(s / 3600), "hour");
  return n(Math.round(s / 86400), "day");
}

function SecHead({ n, title, lead, id }: { n: string; title: string; lead?: string; id?: string }) {
  return (
    <div className="sechead rv" id={id}>
      <span className="num">{n}</span>
      <h2>{title}</h2>
      {lead && <p className="lead">{lead}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ hero
// Replay of one real swap: sealed, price locked, open. The last slot lowers the blind again before the loop.
const T = [0, 1200, 2300, 3400, 5600, 11600, 13000];
const STAGE = ["Sealed", "Price locked", "Open at one price"];
const stageOf = (step: number) => (step >= 4 && step < 5 ? 2 : step >= 2 && step < 4 ? 1 : 0);
const blindFor = (step: number): BlindState => (step === 4 ? "open" : step === 3 ? "opening" : "closed");

function Hero({ rec }: { rec: BatchRec | null }) {
  const [reduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [step, setStep] = useState(reduced ? 4 : 0);
  const sec = useRef<HTMLElement>(null);
  const seen = useRef(true);
  useEffect(() => {
    const io = new IntersectionObserver((es) => { seen.current = es[es.length - 1].isIntersecting; });
    if (sec.current) io.observe(sec.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (reduced || !rec) return;
    const start = performance.now();
    const t = setInterval(() => {
      if (document.hidden || !seen.current) return; // nothing to replay while the hero is out of view
      const ms = (performance.now() - start) % T[6];
      setStep(T.findIndex((x, i) => ms >= x && ms < T[i + 1]));
    }, 200);
    return () => clearInterval(t);
  }, [reduced, rec]);
  const when = rec?.endedAt ? agoWords(rec.endedAt) : "";
  return (
    <section className="hero" ref={sec}>
      <div className="wrap herogrid">
        <div className="herotext">
          <h1>Trade behind the blinds. <span>They open only after the price is locked.</span></h1>
          <p className="sub">On a public chain, bots see your swap before it lands and trade ahead of you. On Blind your swap is sealed until the price is locked, so there is nothing to see.</p>
          <div className="ctas">
            <Link to="/app" className="btn day">Try it, no wallet needed</Link>
            <Link to="/app?wallet=qorex" className="btn line">Use your QoreX wallet</Link>
          </div>
        </div>
        <div className="herowin">
          <Blind className="big" state={blindFor(step)} label="A real sealed swap, replayed">
            <HeroPanel rec={rec} />
          </Blind>
          <ol className="strip three" aria-label="What happens to a sealed swap">
            {STAGE.map((n, i) => <li key={n} className={i === stageOf(step) ? "on" : ""}><span>{n}</span></li>)}
          </ol>
          <p className="herocap">{rec ? `A real swap on QoreChain testnet${when ? `, ${when}` : ""}.` : "Reading the latest swap from QoreChain testnet."}</p>
        </div>
      </div>
    </section>
  );
}

function HeroPanel({ rec }: { rec: BatchRec | null }) {
  if (!rec) return <div className="bp"><div className="bp-h"><span>Reading the latest swap</span></div></div>;
  const fills = rec.fills ?? [];
  return (
    <div className="bp">
      <div className="bp-h"><span>Behind the blind</span><span>vs the public pool</span></div>
      {fills.slice(0, 3).map((f, i) => (
        <div className="bp-r" key={i}>
          <span className="side">{f.buy ? "Buy" : "Sell"}</span>
          <span className="what">{inLabel(f)} <span className="arr">for</span> {outLabel(f)}</span>
          <Edge f={f} />
        </div>
      ))}
      {fills.length > 3 && <div className="bp-more">and {fills.length - 3} more</div>}
      {rec.settle && (
        <div className="bp-p">
          <span>One price for everyone</span>
          <b>{price(rec.settle.price)} <small>fUSD per fETH</small></b>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 01 what a bot does
function attackLine(a: Attempt) {
  const what = a.side === "buy" ? `bought fETH with ${(Number(a.amountIn) / 1e6).toFixed(2)} fUSD` : `sold ${(Number(a.amountIn) / 1e18).toFixed(4)} fETH`;
  return `Someone ${what} in public, ${agoWords(a.at)}. The bot saw it waiting, traded ahead of it, and traded back right after.`;
}

function Problem({ bot, env, envMissing }: { bot: BotStats | null; env: Envelope | null; envMissing: boolean }) {
  const a = bot?.recent.find((x) => x.order === "bot first" && x.victimLossBps != null && x.victimGot && x.victimWouldGet) ?? null;
  const lines = env ? (env.hexHead.match(/.{1,32}/g) ?? []).map((l) => l.match(/.{1,4}/g)!.join(" ")) : [];
  return (
    <section className="sec wrap" id="problem">
      <SecHead n="01" title="What a bot does to a public swap" lead="We run a bot on QoreChain testnet that goes after every public swap on our pool. This is its latest real one." />
      <div className="duo rv">
        <div className="duorow">
          <Blind state="open" flat className="small">
            {a ? (
              <div className="atkp">
                <p>{attackLine(a)}</p>
                <div className="atkn">
                  <div><span>They got</span><b>{attemptOut(a, a.victimGot!)}</b></div>
                  <div><span>Without the bot</span><b>{attemptOut(a, a.victimWouldGet!)}</b></div>
                  <div className="lost"><span>Lost to the bot</span><b>{(a.victimLossBps! / 100).toFixed(2)}%</b></div>
                </div>
              </div>
            ) : (
              <div className="atkp"><p>{bot ? "No attack recorded yet. Send a public swap from the app and it shows up here." : "Reading the bot's latest attack."}</p></div>
            )}
          </Blind>
          {a && (
            <p className="quiet">
              See it on chain: {a.frontHash && <><a href={txUrl(a.frontHash)} target="_blank" rel="noreferrer">the bot's first trade</a>, </>}
              <a href={txUrl(a.victimHash)} target="_blank" rel="noreferrer">the swap</a>
              {a.backHash && <>, <a href={txUrl(a.backHash)} target="_blank" rel="noreferrer">the bot's trade back</a></>}.
            </p>
          )}
        </div>

        <div className="duorow">
          <h3 className="duoh">What the same bot sees on Blind</h3>
          {a && (
            <p className="readout">
              <span>From the public swap above, the bot read:</span>
              <b>{a.side === "buy" ? `Buy fETH with ${(Number(a.amountIn) / 1e6).toFixed(2)} fUSD, accepts as little as ${attemptOut(a, a.minOut)}` : `Sell ${(Number(a.amountIn) / 1e18).toFixed(4)} fETH, accepts as little as ${attemptOut(a, a.minOut)}`}</b>
              <span>From a Blind swap, it reads only this:</span>
            </p>
          )}
          {env ? (
            <div className="sealedhex" aria-label="The first bytes of a real sealed swap, as posted on chain">
              {lines.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          ) : (
            <div className="sealedhex empty" aria-hidden><span className="slats closed big"><i /><i /><i /><i /><i /><i /></span></div>
          )}
          <p className="quiet">
            {env
              ? `A real sealed swap, copied from QoreChain: ${env.bytes.toLocaleString("en-US")} bytes of this. No side, no amount, no limit. It turns back into an order only after the market maker has locked its price, so there is nothing to trade ahead of.`
              : envMissing
                ? "Every sealed swap lands on chain as 6,648 bytes of sealed data. No side, no amount, nothing to trade ahead of."
                : "Reading the newest sealed swap from the chain."}
          </p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ 02 how it works
const HOW: { s: BlindState | "locked"; t: string }[] = [
  { s: "closed", t: "You seal your swap in your browser." },
  { s: "locked", t: "The market maker locks its price before anyone can open an order." },
  { s: "open", t: "Every swap that arrived in the same 20 seconds settles together at one price." },
];

function How() {
  return (
    <section className="sec wrap" id="how">
      <SecHead n="02" title="How it works" />
      <ol className="how3 rv">
        {HOW.map((h, i) => (
          <li key={i}>
            <span className={`slats ${h.s}`} aria-hidden><i /><i /><i /><i /><i /><i /></span>
            <span className="hn">{i + 1}</span>
            <p>{h.t}</p>
          </li>
        ))}
      </ol>
      <p className="quiet rv">Under the hood: post quantum keys and sealing on QoreChain. <Link to="/proof#how">See how</Link></p>
    </section>
  );
}

// ------------------------------------------------------------------ 03 the record
function Record({ b, bot }: { b: Batches | null; bot: BotStats | null }) {
  const app = b ? summarize(b.live) : null;
  const all = b ? summarize([...b.live, ...b.testRuns]) : null;
  return (
    <section className="sec wrap" id="record">
      <SecHead n="03" title="The record so far" />
      <div className="figs three big rv">
        <div>
          <b>{bot ? `${bot.hits} of ${bot.tried}` : "…"}</b>
          <span>{bot ? `public swaps the bot got ahead of${bot.avgLossBps !== null ? `, taking ${(bot.avgLossBps / 100).toFixed(2)}% on average` : ""}` : "public swaps the bot got ahead of"}</span>
        </div>
        <div>
          <b className={app?.avgBps != null && app.avgBps < 0 ? "neg" : ""}>{app ? (app.avgBps !== null ? pct(app.avgBps) : "none yet") : "…"}</b>
          <span>how sealed swaps did on average, against the same swap on QoreChain's public pool</span>
        </div>
        <div>
          <b>{all ? all.fills.toLocaleString("en-US") : "…"}</b>
          <span>sealed swaps settled on QoreChain testnet</span>
        </div>
      </div>
      <Link to="/proof" className="btn line rv">See every swap</Link>
    </section>
  );
}

// ------------------------------------------------------------------ 04 questions
const QA: [string, string][] = [
  ["What is a batch?", "Every swap that arrives in the same 20 seconds. They settle together at one price, so the order inside a batch cannot be exploited."],
  ["Is this real money?", "No. Blind runs on QoreChain testnet, as the hackathon asks, with test tokens that have no value. Every swap is still a real transaction on chain."],
  ["Do I need a wallet?", "No. One button makes a test account in this browser and fills it with test tokens. If you already use QoreX, you can trade from it instead."],
  ["Who can read my order?", "Not bots and not other traders: your swap is sealed in your browser. The operator that runs Blind holds the key for each batch, so you trust it not to peek. The chain proves the price was locked before any order was opened."],
  ["Why does my public swap lose to the bot?", "We run that bot ourselves on testnet. It does what bots do on any public chain: reads your swap while it waits, trades first and trades back after. It is there so you can see what Blind keeps you out of."],
];
function Faq() {
  return (
    <section className="sec wrap lastsec" id="faq">
      <SecHead n="04" title="Questions" />
      <div className="faq rv">
        {QA.map(([q, a], i) => (
          <details className="qa" key={q} open={i === 0} {...{ name: "faq" }}><summary>{q}</summary><div className="a">{a}</div></details>
        ))}
      </div>
    </section>
  );
}
