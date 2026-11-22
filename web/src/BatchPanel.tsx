import type { BatchRec } from "./lib/api";
import { price, blockNo, inLabel, outLabel } from "./lib/fmt";
import { Edge } from "./ui";

/** What a settled batch looks like in daylight: each fill against x/amm, and the one price. */
export default function BatchPanel({ rec, max = 3, priced = true }: { rec: BatchRec | null; max?: number; priced?: boolean }) {
  if (!rec) return <div className="bp"><div className="bp-h"><span>Reading the latest batch from the chain</span></div></div>;
  const fills = rec.fills ?? [];
  return (
    <div className="bp">
      <div className="bp-h"><span>Batch {rec.batch}{rec.open ? ` · opened at block ${blockNo(rec.open.block)}` : ""}</span><span>vs x/amm</span></div>
      {fills.slice(0, max).map((f, i) => (
        <div className="bp-r" key={i}>
          <span className="side">{f.buy ? "Buy" : "Sell"}</span>
          <span className="what">{inLabel(f)} <span className="arr">for</span> {outLabel(f)}</span>
          <Edge f={f} />
        </div>
      ))}
      {fills.length > max && <div className="bp-more">and {fills.length - max} more</div>}
      {priced && rec.settle && (
        <div className="bp-p">
          <span>One price for everyone, computed by the contract</span>
          <b>{price(rec.settle.price)} <small>fUSD per fETH</small></b>
        </div>
      )}
    </div>
  );
}
