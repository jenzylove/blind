import { useState } from "react";
import { api, type BatchRec } from "../lib/api";
import { price, blockNo, summarize, pct, inLabel, outLabel, usd, ago, type Summary } from "../lib/fmt";
import { Edge, usePoll, navigate, Link } from "../ui";

export default function Proof() {
  const { v: b, err } = usePoll(api.batches, 10000);
  const { v: v1 } = usePoll(api.batchesV1, 600000);
  const [filter, setFilter] = useState<"all" | "app" | "test">("all");
  const live = b?.live ?? [];
  const test = b ? [...b.testRuns].reverse() : [];
  const rows = filter === "app" ? live : filter === "test" ? test : [...live, ...test];
  const cur = summarize([...live, ...test]);
  const old = v1 ? summarize(v1) : null;
  const worst = (rs: BatchRec[]) => {
    const e = rs.filter((r) => r.settled).flatMap((r) => r.fills ?? []).map((f) => (BigInt(f.plainAmm) === 0n ? null : Number(((BigInt(f.amountOut) - BigInt(f.plainAmm)) * 1_000_000n) / BigInt(f.plainAmm)) / 100)).filter((x): x is number => x !== null);
    return e.length ? Math.min(...e) : null;
  };
  return (
    <div className="page wrap">
      <div className="apphead">
        <h1>Every batch</h1>
        <p className="mute" style={{ margin: 0, maxWidth: 520 }}>Each fill next to a plain x/amm swap of the same input at the block before settlement. Fills worse than x/amm stay in the table.</p>
      </div>

      <div className="figs" style={{ marginTop: 28 }}>
        <div><div className="v">{b ? live.filter((r) => r.settled).length : "…"}</div><div className="k">batches from the app</div></div>
        <div><div className="v">{b ? test.filter((r) => r.settled).length : "…"}</div><div className="k">batches from test traders (our accounts)</div></div>
        <div><div className="v">{b ? `${cur.better} of ${cur.compared}` : "…"}</div><div className="k">fills beat x/amm</div></div>
        <div><div className="v">{b && cur.markoutUsd !== null ? `${cur.markoutUsd >= 0 ? "+" : "−"}${Math.abs(cur.markoutUsd).toFixed(3)}` : "…"}</div><div className="k">market maker result in fUSD, 30 blocks after each batch</div></div>
      </div>

      <h2 style={{ fontSize: 26, fontVariationSettings: '"wdth" 80', margin: "10px 0 6px" }}>The first version missed. Here is the fix.</h2>
      <p style={{ maxWidth: 760, color: "var(--ink2)", margin: "0 0 10px" }}>The first contract quoted one band price for any net size. Traders on the heavy side of a batch got less than x/amm. The current contract commits a price curve instead: small orders pay close to the pool, larger ones pay for their own hedge, and the contract solves the exact price on that curve.</p>
      <div className="vnote">
        <VersionFig title="First version, flat band" s={old} worst={v1 ? worst(v1) : null} />
        <VersionFig title="Current version, curve" s={b ? cur : null} worst={b ? worst([...live, ...test]) : null} />
      </div>

      <div className="filters">
        <div className="chips">
          {(["all", "app", "test"] as const).map((k) => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k === "all" ? "All" : k === "app" ? "From the app" : "Test traders"}</button>)}
        </div>
      </div>
      {err && <div className="msg err">The server is not answering. Retrying.</div>}
      <table className="tbl resp">
        <thead><tr><th>Batch</th><th>Who</th><th>Blocks: open, commit, reveal, settle</th><th>Committed curve</th><th>One price</th><th>Fills vs x/amm</th><th>Left out</th><th>Maker, 30 blocks later</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.live ? "l" : "t"}${r.batch}`} className="click" onClick={() => navigate(`/batch/${r.batch}`)}>
              <td data-k="Batch" className="mono">{r.batch}</td>
              <td data-k="Who">{r.live ? <span className="tag wax">app</span> : <span className="tag">test traders</span>}<div className="small mute" style={{ marginTop: 4 }}>{r.live ? ago(r.endedAt) : ""}</div></td>
              <td data-k="Blocks" className="mono">{[r.create?.block, r.commit?.block, r.open?.block, r.settle?.block].filter(Boolean).map((x) => blockNo(x)).join(", ") || "none"}</td>
              <td data-k="Curve" className="mono small">{r.commit ? <>bid {price(r.commit.bid)}<br />ask {price(r.commit.ask)}</> : "not committed"}</td>
              <td data-k="Price" className="mono">{r.settle ? price(r.settle.price) : r.error ? "stopped" : "not settled"}</td>
              <td data-k="Fills">
                <div style={{ display: "grid", gap: 6 }}>
                  {(r.fills ?? []).map((f, i) => (
                    <div key={i} style={{ display: "grid", gap: 2 }}>
                      <span className="small mono">{f.buy ? "buy" : "sell"} {inLabel(f)} → {outLabel(f)}{f.standing ? " (limit)" : ""}</span>
                      <Edge f={f} />
                    </div>
                  ))}
                  {!r.fills?.length && <span className="mute small">none</span>}
                </div>
              </td>
              <td data-k="Left out" className="small">{r.dropped?.length ? r.dropped.map((d, i) => <div key={i}>{d.reason}</div>) : <span className="mute">none</span>}</td>
              <td data-k="Maker" className="mono">{r.markout ? `${Number(r.markout.afterHedge) >= 0 ? "+" : "−"}${usd(String(Math.abs(Number(r.markout.afterHedge))), 4)}` : <span className="mute small">{r.settled ? "waiting 30 blocks" : "none"}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {b && !rows.length && <div className="empty">{filter === "app" ? "No batches from the app yet. " : "No batches yet. "}<Link to="/app">Place the first sealed swap.</Link></div>}
      {!b && !err && <div className="empty">Reading batches from the server.</div>}
    </div>
  );
}

function VersionFig({ title, s, worst }: { title: string; s: Summary | null; worst: number | null }) {
  return (
    <div>
      <div className="small mute" style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>{title}</div>
      {s ? (
        <>
          <div className="v" style={{ marginTop: 8 }}>{s.avgBps !== null ? pct(s.avgBps) : "none"} <span className="small mute">average vs x/amm</span></div>
          <div style={{ marginTop: 8, color: "var(--ink2)" }}>{s.batches} batches, {s.fills} fills. {s.better} beat x/amm, {s.worse} came out worse{s.refused ? `, ${s.refused} sizes x/amm refused` : ""}.{worst !== null ? ` Worst fill ${pct(worst)}.` : ""}</div>
        </>
      ) : <div className="mute" style={{ marginTop: 8 }}>Reading</div>}
    </div>
  );
}
