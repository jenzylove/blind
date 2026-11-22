// Market data for the trading screen: a sampler of the x/amm pool price, kept on the data volume.
// Read only. Nothing here signs, posts or settles.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** [time in ms, fUSD per fETH] */
export type Pt = [number, number];
const KEEP_MS = 3 * 86_400_000;

/** A pool price is fUSD base units per fETH, scaled by 1e18: shown as fUSD per fETH. */
export const priceOf = (scaled: bigint | string) => Number(scaled) / 1e6;

/** Points to start from on a fresh volume: the pool price each batch recorded when its price was locked, and after it rebalanced. */
export function seedFrom(records: any[]): Pt[] {
  const out: Pt[] = [];
  for (const r of records) {
    const a = Date.parse(r.startedAt ?? ""), b = Date.parse(r.endedAt ?? "");
    if (r.commit?.mid && Number.isFinite(a)) out.push([a, priceOf(r.commit.mid)]);
    if (r.midAfterHedge && Number.isFinite(b)) out.push([b, priceOf(r.midAfterHedge)]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** Settled batch prices as chart dots: [time, price, batch number]. */
export function batchDots(records: any[], since = Date.now() - KEEP_MS): [number, number, number][] {
  return records
    .filter((r) => r.settled && r.settle?.price && r.endedAt && Date.parse(r.endedAt) >= since)
    .map((r) => [Date.parse(r.endedAt), priceOf(r.settle.price), r.batch] as [number, number, number])
    .sort((x, y) => x[0] - y[0]);
}

/**
 * Samples the pool price on a timer. The price only moves when someone trades, so a sample is stored
 * only when the price changed; the time of the newest sample is kept beside it. Nothing is lost.
 */
export class MarketSampler {
  /** Change points, oldest first. */
  points: Pt[] = [];
  /** When the pool was last read, and what it said. */
  lastAt = 0;
  mid: number | null = null;
  private n = 0;

  constructor(private file: string, private readMid: () => Promise<number>, seed: () => Pt[] = () => []) {
    try {
      if (existsSync(file)) {
        const j = JSON.parse(readFileSync(file, "utf8"));
        this.points = (j.points ?? []).filter((p: any) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        this.lastAt = Number(j.lastAt ?? 0);
      }
    } catch { /* a damaged file: start again from the batch records */ }
    if (!this.points.length) for (const p of seed()) this.push(p[0], p[1]);
    if (this.points.length) {
      this.mid = this.points[this.points.length - 1][1];
      this.lastAt = Math.max(this.lastAt, this.points[this.points.length - 1][0]);
    }
    this.trim();
  }

  private push(t: number, v: number) {
    const last = this.points[this.points.length - 1];
    if (last && last[1] === v) return false;
    this.points.push([t, v]);
    return true;
  }
  private trim() {
    const from = Date.now() - KEEP_MS;
    // Keep the newest point before the window so the line still knows its level at the left edge.
    let i = 0;
    while (i + 1 < this.points.length && this.points[i + 1][0] < from) i++;
    if (i > 0) this.points.splice(0, i);
  }
  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ lastAt: this.lastAt, points: this.points }));
    } catch { /* the volume is not writable: keep sampling in memory */ }
  }

  async sample() {
    const v = await this.readMid();
    if (!Number.isFinite(v) || v <= 0) return;
    const now = Date.now();
    const changed = this.push(now, v);
    this.mid = v; this.lastAt = now;
    this.trim();
    // Write on every change, and now and then so the newest sample time survives a restart.
    if (changed || ++this.n % 10 === 0) this.save();
  }

  start(everyMs = 30_000) {
    const go = () => this.sample().catch(() => undefined);
    go();
    return setInterval(go, everyMs);
  }

  /** The stored change points, closed with the newest sample so the line runs up to now. */
  series(): Pt[] {
    const last = this.points[this.points.length - 1];
    return last && this.lastAt > last[0] ? [...this.points, [this.lastAt, last[1]]] : [...this.points];
  }
}
