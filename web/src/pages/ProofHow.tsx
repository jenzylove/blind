// The technical "how": each batch step with the QoreChain piece doing it, the full list of QoreChain
// features in use, and what the chain checks versus what you trust. Moved here from the landing page.
import { useLive, Link, StepQc, Qc, latestSettled, STEPS } from "../ui";
import { batchPath, type BatchRec, type Batches } from "../lib/api";
import { blockNo } from "../lib/fmt";
import { viaLinkedKey, COMMIT_PLAIN, txUrl, CONTRACT_URL, RELAY_SRC, LIMIT_SRC, QORESCAN_URL, QCAI_URL, STEP_TECH } from "../lib/qore";

const HOW = [
  "Your order is signed and locked in your browser to this batch's public key. Nothing readable leaves the page.",
  "The sealed order lands on chain. Anyone can see that an order exists. Nobody can see its side, size or limit.",
  "Intake closes after 20 seconds. The market maker prices from public data only and locks a signed price curve on chain.",
  "In a later block each owner's browser reveals its own order. The contract checks it against the fingerprint posted earlier, and waits for every reveal or the end of the window.",
  "One transaction. The contract sets one price on the locked curve, checks every signature, and pays everyone at that price.",
];

const hashesOf = (rec: BatchRec) => [undefined, rec.posts?.[0]?.hash ?? rec.create?.hash, rec.commit?.hash, rec.open?.hash ?? rec.reveals?.[0]?.hash, rec.settle?.hash] as (string | undefined)[];
const blocksOf = (rec: BatchRec) => [null, rec.posts?.[0]?.block ?? rec.create?.block, rec.commit?.block, rec.open?.block ?? rec.reveals?.[0]?.block, rec.settle?.block] as (number | null | undefined)[];

export default function ProofHow({ b }: { b: Batches | null }) {
  const rec = latestSettled(b);
  return (
    <>
      <HowSteps rec={rec} />
      <Built rec={rec} />
      <Limits />
    </>
  );
}

function HowSteps({ rec }: { rec: BatchRec | null }) {
  const bl = rec ? blocksOf(rec) : null;
  const hs = rec ? hashesOf(rec) : null;
  const bytes = rec?.posts?.find((p) => p.bytes)?.bytes;
  return (
    <section className="vfix wide" id="how">
      <h2>How a batch works, with the tech</h2>
      <p>Five steps. The price is on chain before any order can be read.{rec ? <> Block numbers below are from <Link to={batchPath(rec)}>batch {rec.batch}</Link>.</> : null}</p>
      <ol className="techsteps">
        {STEPS.map((n, i) => (
          <li key={n}>
            <div className="k"><span>{String(i + 1).padStart(2, "0")}</span><span>{bl ? (bl[i] ? `block ${blockNo(bl[i]!)}` : "in your browser") : ""}</span></div>
            <h3>{n}</h3>
            <p>{HOW[i]}</p>
            {i === 2 && rec && !viaLinkedKey(rec.commit?.hash)
              ? <Qc name={COMMIT_PLAIN.name} href={hs?.[2] ? txUrl(hs[2]!) : undefined} link={`batch ${rec.batch}, this step`}>{COMMIT_PLAIN.rest}</Qc>
              : <StepQc i={i} href={hs?.[i] ? txUrl(hs[i]!) : undefined} link={rec ? `batch ${rec.batch}, this step` : undefined}>
                {i === 0 && bytes ? `${STEP_TECH[0].rest}. ${bytes.toLocaleString("en-US")} bytes per order` : undefined}
              </StepQc>}
          </li>
        ))}
      </ol>
    </section>
  );
}

interface Row { name: string; what: string; use: string; href: string; link: string }
function Built({ rec }: { rec: BatchRec | null }) {
  const { s } = useLive();
  const tx = (h: string | undefined, fallback: string) => (h ? txUrl(h) : fallback);
  const rows: Row[] = [
    { name: "ML-DSA-87 accounts and precompiles", what: "Post quantum keys held on chain", use: "Every test account registers its ML-DSA-87 key with proof of possession (MsgRegisterPQCKeyV2) and hybrid signs everything after. At settlement BlindSettlement checks each order's signature through pqcVerify (0x0A01) against the key pqcKeyStatus (0x0A02) reports.", href: tx(rec?.settle?.hash, CONTRACT_URL), link: rec ? `Settlement of batch ${rec.batch}` : "The contract" },
    { name: "Commit and reveal", what: "Orders that cannot be read early", use: "Each swap goes on chain as a 32 byte fingerprint of the order, its ML-DSA-87 signature and a random salt. Your browser reveals it after the price is locked, and BlindSettlement checks it matches. There is no key for anyone to hold, steal or break.", href: tx(rec?.posts?.[0]?.hash, CONTRACT_URL), link: rec ? `A posted fingerprint in batch ${rec.batch}` : "The contract" },
    { name: "QoreSeal", what: "Hybrid post quantum sealed envelopes", use: "Limit orders wait across batches while you are offline, so they are sealed with ML-KEM-1024 + X25519 to our standing key, and we reveal them.", href: LIMIT_SRC, link: "Where it runs" },
    { name: "Scoped EVM windows", what: "Limits on what EVM keys do", use: "Your test account opens a window for two approvals, to fUSD and fETH only. The operator opens batches, posts fingerprints, relays reveals and settles inside its own window: 400 transactions, 3,000 blocks, BlindSettlement only.", href: CONTRACT_URL, link: "BlindSettlement on QoreChain EVM" },
    { name: "Account abstraction spending rule", what: "Linked keys with chain enforced limits", use: "Only the maker account may commit a price, and the agent acts for it through its own ed25519 key. The chain lets that key call commit on Blind and nothing else, 1 uqor per call and per day. Every curve must also sit inside a mandate the owner signs with ML-DSA-87.", href: "/proof#agent", link: "The live rule" },
    { name: "QoreSign", what: "Hybrid signature checks before broadcast", use: "The relayer checks both halves of every transaction your browser sends, including ML-DSA-87 against the key registered on chain, before it broadcasts.", href: RELAY_SRC, link: "The relay check" },
    { name: "x/amm", what: "QoreChain's built in exchange", use: "The agent rebalances on pool 3 (fETH/fUSD) from a separate account. Every fill is compared with it, and the public lane swaps on it while our bot reads the public mempool.", href: tx(rec?.hedge?.hash, "/proof#bot"), link: rec?.hedge?.hash ? `Rebalance after batch ${rec.batch}` : "The bot's record" },
    { name: "@qorechain/pqc", what: "ML-DSA-87 in plain JavaScript", use: "Checks a limit order's signature the moment it arrives, before it waits for a batch.", href: LIMIT_SRC, link: "Where it runs" },
    { name: "QoreScan", what: "Cryptography inventory of a project", use: "A CBOM of Blind's accounts, live site and contract: what is post quantum, and what is not.", href: QORESCAN_URL, link: "The scan" },
    { name: "QCAI audit", what: "QoreChain's AI contract auditor", use: "Reviewed BlindSettlement. Our answer to each finding points at a test that proves it.", href: QCAI_URL, link: "The answers" },
    { name: "Faucet tokens", what: "Test fUSD and fETH", use: "The relayer funds each test account and converts bank coins into ERC-20 tokens with MsgConvertCoin.", href: s ? `https://explore.qore.network/address/${s.tokens.fUSD.address}` : CONTRACT_URL, link: s ? "fUSD token" : "The contract" },
  ];
  return (
    <section className="vfix wide" id="qorechain">
      <h2>Built on QoreChain</h2>
      <p>Each piece of QoreChain that does real work in Blind, in order of how much rests on it.</p>
      <ol className="built">
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

function Limits() {
  return (
    <section className="vfix wide" id="trust">
      <h2>What the chain checks, and what it does not</h2>
      <p>Sealing stops bots from reading your order, and the market maker locks its price before any order opens. It does not remove every party you trust.</p>
      <div className="limits">
        <div className="lit">
          <h3>In daylight: the chain checks</h3>
          <ul>
            <li><b>The price came first.</b> The market maker's curve is on chain, signed, while every order is still only a fingerprint.</li>
            <li><b>Nobody read your order early.</b> Until the price is locked the chain holds only its fingerprint; the contract accepts a reveal only after the commit block and only if it matches.</li>
            <li><b>Nobody was cut short.</b> The batch settles only once every order is revealed or the reveal window is over.</li>
            <li><b>The contract sets the price,</b> not the operator, from the locked curve and the orders.</li>
            <li><b>Every order is yours.</b> Each carries your post quantum signature, checked against the key QoreChain holds for your account.</li>
            <li><b>Your limit holds.</b> Nobody is filled below the minimum they signed.</li>
            <li><b>The agent is on a leash.</b> Only the maker account may commit, and the agent's key for it may call nothing else (a spending rule QoreChain enforces). Every curve must sit inside the owner's ML-DSA-87 signed mandate: size, spread, distance from the last price, expiry.</li>
            <li><b>The inventory stays put.</b> It leaves only to the treasury, only with the owner's ML-DSA-87 signature, and only within a daily limit.</li>
          </ul>
        </div>
        <div className="shade">
          <h3>In the shade: you trust the operator for</h3>
          <ul>
            <li><b>Limit orders.</b> They wait across batches while you are offline, so they are sealed (QoreSeal, ML-KEM-1024) to our standing key and we reveal them. Swaps need no trust here: nobody but your browser ever holds them before the reveal.</li>
            <li><b>Relaying your reveal.</b> Your browser hands its order to our server only after the price is locked on chain, and we relay it. If we failed to, your order would simply not fill; nothing moves without your reveal.</li>
            <li><b>Including you.</b> The operator picks which revealed orders go to settlement, though the contract makes it wait for every reveal. Left out orders are listed with the reason.</li>
            <li><b>Price when alone.</b> Trading alone you pay about what x/amm charges plus 0.15%. When buyers and sellers meet in a batch, the lighter side gets a much better price than x/amm and the heavier side pays about the market maker's price for the rest.</li>
            <li><b>Testnet.</b> fUSD, fETH and QOR here are test tokens with no value.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
