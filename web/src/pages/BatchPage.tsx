import { api } from "../lib/api";
import { price, blockNo, inLabel, outLabel, short, usd, eth } from "../lib/fmt";
import { Edge, usePoll, TxLink, Link } from "../ui";
import { Curve } from "./Landing";

export default function BatchPage({ id }: { id: number }) {
  const { v: r, err } = usePoll(() => api.batch(id), 15000, [id]);
  if (!r) return (
    <div className="page wrap">
      <div className="apphead"><h1>Batch {id}</h1></div>
      <div className="empty">{err ? <>This batch is not recorded yet. It appears here once it has settled. <Link to="/proof">Every batch</Link></> : "Reading the batch."}</div>
    </div>
  );
  const steps: [string, string, number | undefined, string | undefined][] = [
    ["Batch opened", "Its key's hash fixed on chain", r.create?.block, r.create?.hash],
    ...(r.posts ?? []).map((p, i) => [`Sealed order ${i + 1}`, p.bytes ? `${p.bytes.toLocaleString("en-US")} bytes of ciphertext` : "Envelope posted, unreadable", p.block, p.hash] as [string, string, number, string]),
    ["Price committed", "The market maker's signed curve", r.commit?.block, r.commit?.hash],
    ["Key revealed", "Every envelope can now be opened from chain data", r.open?.block, r.open?.hash],
    ["Settled", r.settle ? `One price, ${r.fills?.length ?? 0} fills` : "Did not settle", r.settle?.block, r.settle?.hash],
  ];
  return (
    <div className="page wrap">
      <div className="apphead">
        <h1>Batch {r.batch}</h1>
        <p className="mute" style={{ margin: 0 }}>{r.live ? "Placed from the app" : "Test traders (our accounts)"}{r.settle ? `. Settled at ${price(r.settle.price)} fUSD per fETH.` : "."}</p>
      </div>

      <div className="appgrid side">
        <div className="col">
          <div className="colh"><span>In order, block by block</span></div>
          <table className="tbl resp">
            <thead><tr><th>Step</th><th>What happened</th><th>Block</th><th>Transaction</th></tr></thead>
            <tbody>
              {steps.map(([a, b, bl, h], i) => (
                <tr key={i}><td data-k="Step"><b>{a}</b></td><td data-k="What">{b}</td><td data-k="Block" className="mono">{blockNo(bl)}</td><td data-k="Tx"><TxLink h={h} /></td></tr>
              ))}
            </tbody>
          </table>
          {r.commit && r.open && <p className="small mute">The curve landed in block {blockNo(r.commit.block)}, the key in block {blockNo(r.open.block)}: the price was fixed {r.open.block - r.commit.block} blocks before any order could be read.</p>}

          <div className="colh" style={{ marginTop: 36 }}><span>Fills vs a plain x/amm swap</span></div>
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
              <div className="colh" style={{ marginTop: 30 }}><span>Left out</span></div>
              {r.dropped.map((d, i) => <div key={i} className="msg"><span className="mono">{short(d.user, 6, 4)}</span>: {d.reason}. Nothing moved from this account.</div>)}
            </>
          )}
          {r.error && <div className="msg err">This batch stopped: {r.error.slice(0, 160)}</div>}
        </div>
        <div className="col">
          <Curve rec={r.settle ? r : null} on dot />
          <div className="kv" style={{ gridTemplateColumns: "1fr", marginTop: 20 }}>
            {r.settle && <><div>Market maker net</div><div className="mono">{Number(r.settle.makerBase) < 0 ? "sold" : "bought"} {eth(String(Math.abs(Number(r.settle.makerBase))), 6)} fETH</div></>}
            <div>Rebalance on x/amm</div>
            <div>{r.hedge?.hash ? <TxLink h={r.hedge.hash} /> : <span className="mute">{r.hedge?.skipped ? "not needed, net too small" : r.hedge?.failed ? "failed, see the build log" : "none"}</span>}</div>
            <div>Market maker, 30 blocks later</div>
            <div className="mono">{r.markout ? `${Number(r.markout.afterHedge) >= 0 ? "+" : "−"}${usd(String(Math.abs(Number(r.markout.afterHedge))), 4)} fUSD` : <span className="mute">{r.settled ? "waiting for 30 blocks" : "none"}</span>}</div>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 30 }}><Link to="/proof" className="btn">Every batch</Link></div>
    </div>
  );
}
