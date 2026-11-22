import { api } from "../lib/api";
import { price, blockNo, inLabel, outLabel, short, usd, eth } from "../lib/fmt";
import { Edge, usePoll, TxLink, Link, Curve, Qc, StepQc } from "../ui";
import type { ReactNode } from "react";
import { viaLinkedKey, COMMIT_PLAIN } from "../lib/qore";
import Blind from "../Blind";
import BatchPanel from "../BatchPanel";

export default function BatchPage({ id }: { id: number }) {
  const { v: r, err } = usePoll(() => api.batch(id), 15000, [id]);
  if (!r) return (
    <div className="page wrap">
      <div className="apphead"><h1>Batch {id}</h1></div>
      <div className="empty">{err ? <>This batch is not recorded yet. It appears here once it has settled. <Link to="/proof">Every batch</Link></> : "Reading the batch."}</div>
    </div>
  );
  const posts = r.posts ?? [];
  const steps: [string, string, number | undefined, string | undefined, ReactNode?][] = [
    ["Batch opened", "Its key's fingerprint fixed on chain", r.create?.block, r.create?.hash, <Qc name="QoreChain EVM">BlindSettlement fixes the batch key's fingerprint</Qc>],
    ...posts.map((p, i) => [`Sealed order ${i + 1}`, p.bytes ? `${p.bytes.toLocaleString("en-US")} bytes, unreadable` : "Posted, unreadable", p.block, p.hash, i === 0 ? <StepQc i={0} /> : undefined] as [string, string, number, string, ReactNode?]),
    ["Price locked", "The market maker's signed curve", r.commit?.block, r.commit?.hash, viaLinkedKey(r.commit?.hash) ? <StepQc i={2} href="/proof#agent" link="the rule" /> : <Qc name={COMMIT_PLAIN.name}>{COMMIT_PLAIN.rest}</Qc>],
    ["Blinds open", "Every order can now be opened from chain data", r.open?.block, r.open?.hash, <Qc name="QoreChain EVM">BlindSettlement checks the revealed key against its fingerprint</Qc>],
    ["Settled", r.settle ? `One price, ${r.fills?.length ?? 0} fills` : "Did not settle", r.settle?.block, r.settle?.hash, r.settle ? <StepQc i={4} /> : undefined],
  ];
  return (
    <div className="page wrap">
      <div className="apphead">
        <h1>Batch {r.batch}</h1>
        <p>{r.live ? "Placed from the app" : "Test traders (our accounts)"}{r.settle ? `. Settled at ${price(r.settle.price)} fUSD per fETH.` : "."}</p>
      </div>

      <div className="batchtop">
        <Blind state={r.settled ? "open" : "closed"} label={`Batch ${r.batch}`}><BatchPanel rec={r} max={6} /></Blind>
        {r.commit && r.open && <p className="cap">The price was locked in block {blockNo(r.commit.block)} and the blinds opened in block {blockNo(r.open.block)}: {r.open.block - r.commit.block} blocks before any order could be read.</p>}
      </div>

      <section className="bsec">
        <h3 className="colh">In order, block by block</h3>
        <div className="tl">
          {steps.map(([a, b, bl, h, q], i) => (
            <div className="tlr" key={i}><b>{a}</b><span>{b}</span><span className="mono">{blockNo(bl)}</span><TxLink h={h} label="view" />{q}</div>
          ))}
        </div>
      </section>

      <section className="bsec">
        <h3 className="colh">Fills next to a plain x/amm swap</h3>
        <table className="tbl resp">
          <thead><tr><th>Trader</th><th>Paid</th><th>Got</th><th>x/amm would pay</th><th>Difference</th></tr></thead>
          <tbody>
            {(r.fills ?? []).map((f, i) => (
              <tr key={i}>
                <td data-k="Trader" className="mono">{short(f.user, 6, 4)}{f.standing ? " (limit)" : ""}</td>
                <td data-k="Paid" className="mono">{inLabel(f)}</td>
                <td data-k="Got" className="mono">{outLabel(f)}</td>
                <td data-k="x/amm" className="mono">{BigInt(f.plainAmm) === 0n ? "refused" : outLabel(f, f.plainAmm)}</td>
                <td data-k="Difference"><Edge f={f} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!r.fills?.length && <div className="empty">No fills in this batch.</div>}
        {!!r.dropped?.length && (
          <>
            <h3 className="colh">Left out</h3>
            {r.dropped.map((d, i) => <div key={i} className="msg"><span className="mono">{short(d.user, 6, 4)}</span>: {d.reason}. Nothing moved from this account.</div>)}
          </>
        )}
        {r.error && <div className="msg err">This batch stopped: {r.error.slice(0, 160)}</div>}
      </section>

      <section className="bsec">
        <h3 className="colh">The price curve the market maker locked</h3>
        <Curve rec={r.settle ? r : null} />
        <div className="kv">
          {r.settle && <div><span>Market maker net</span><span className="mono">{Number(r.settle.makerBase) < 0 ? "sold" : "bought"} {eth(String(Math.abs(Number(r.settle.makerBase))), 6)} fETH</span></div>}
          <div><span>Rebalance on x/amm pool 3</span><span>{r.hedge?.hash ? <TxLink h={r.hedge.hash} label="view" /> : <span className="dim">{r.hedge?.skipped ? "not needed, net too small" : r.hedge?.failed ? "failed, see the build log" : "none"}</span>}</span></div>
          <div><span>Market maker, 30 blocks later</span><span className="mono">{r.markout ? `${Number(r.markout.afterHedge) >= 0 ? "+" : "−"}${usd(String(Math.abs(Number(r.markout.afterHedge))), 4)} fUSD` : <span className="dim">{r.settled ? "waiting for 30 blocks" : "none"}</span>}</span></div>
        </div>
      </section>
      <Link to="/proof" className="btn line">Every batch</Link>
    </div>
  );
}
