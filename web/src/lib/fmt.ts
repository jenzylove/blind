import type { BatchRec, Fill } from "./api";

export const usd = (base: string | bigint, dp = 2) => (Number(base) / 1e6).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const eth = (base: string | bigint, dp = 5) => (Number(base) / 1e18).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
/** Price: fUSD base units per fETH base unit times 1e18, shown as fUSD per fETH. */
export const price = (p: string | bigint, dp = 2) => (Number(p) / 1e6).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const short = (h?: string, a = 6, b = 4) => (!h ? "" : h.length <= a + b + 1 ? h : `${h.slice(0, a)}…${h.slice(-b)}`);
export const blockNo = (n?: number) => (n == null ? "" : n.toLocaleString("en-US"));
export const pct = (bps: number, dp = 2) => `${bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps / 100).toFixed(dp)}%`;

export const inLabel = (f: Fill) => (f.buy ? `${usd(f.amountIn)} fUSD` : `${eth(f.amountIn)} fETH`);
export const outLabel = (f: Fill, v = f.amountOut) => (f.buy ? `${eth(v)} fETH` : `${usd(v)} fUSD`);

/** Blind's output vs a plain x/amm swap of the same input, in bps. null when x/amm refuses the size. */
export function edgeBps(f: Fill): number | null {
  const amm = BigInt(f.plainAmm ?? "0");
  if (amm === 0n) return null;
  return Number(((BigInt(f.amountOut) - amm) * 1_000_000n) / amm) / 100;
}

export interface Summary { batches: number; fills: number; compared: number; better: number; worse: number; refused: number; avgBps: number | null; markoutUsd: number | null; markouts: number }
export function summarize(recs: BatchRec[]): Summary {
  const settled = recs.filter((r) => r.settled);
  const fills = settled.flatMap((r) => r.fills ?? []);
  const e = fills.map(edgeBps);
  const cmp = e.filter((x): x is number => x !== null);
  const mk = settled.filter((r) => r.markout);
  return {
    batches: settled.length, fills: fills.length, compared: cmp.length,
    better: cmp.filter((x) => x > 0).length, worse: cmp.filter((x) => x < 0).length, refused: e.length - cmp.length,
    avgBps: cmp.length ? cmp.reduce((a, b) => a + b, 0) / cmp.length : null,
    markoutUsd: mk.length ? mk.reduce((a, r) => a + Number(r.markout!.afterHedge) / 1e6, 0) : null,
    markouts: mk.length,
  };
}

export function ago(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
