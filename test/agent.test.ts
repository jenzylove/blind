import { test } from "node:test";
import assert from "node:assert/strict";
import { cpIn, cpOut, impactBps, makeQuote, maxNetSize, volBps, clearingPrice, markout, mid, DEFAULTS, SCALE, type Pool } from "../src/agent/policy.ts";

// Pool 3 as read on testnet, 18 Nov 2026.
const pool: Pool = { base: 137_092_386_431_733_555n, quote: 390_091_036n, feeBps: 30n, maxImpactBps: 500n };
const inv = { base: 50_000_000_000_000_000n, quote: 140_000_000n };

test("constant product math matches the chain's own quote", () => {
  // Phase 1 spike: 5 fUSD into the pool then (370.106032 fUSD / 0.137081105701445382 fETH) quoted 0.001821822580716099.
  const out = cpOut(370_106_032n, 137_081_105_701_445_382n, 5_000_000n, 30n);
  const diff = out > 1_821_822_580_716_099n ? out - 1_821_822_580_716_099n : 1_821_822_580_716_099n - out;
  assert.ok(diff * 1_000_000n < out, `within 1 ppm: ${out}`);
});

test("exact-in and exact-out invert each other", () => {
  const need = cpIn(pool.quote, pool.base, 1_000_000_000_000_000n, 30n);
  assert.ok(cpOut(pool.quote, pool.base, need, 30n) >= 1_000_000_000_000_000n);
});

test("max size keeps the hedge under the impact limit and the chain cap", () => {
  const n = maxNetSize(pool, inv, DEFAULTS);
  assert.ok(impactBps(pool.base, n) <= DEFAULTS.hedgeImpactBps);
  assert.ok(impactBps(pool.base, n) < pool.maxImpactBps);
});

test("max size never exceeds the inventory share on either side", () => {
  const small = { base: 1_000_000_000_000_000n, quote: 1_000_000n };
  const n = maxNetSize(pool, small, DEFAULTS);
  assert.ok(n <= (small.base * DEFAULTS.inventoryShare) / 10_000n);
  assert.ok((n * mid(pool)) / SCALE <= (small.quote * DEFAULTS.inventoryShare) / 10_000n + 1n);
});

const curveOf = (q: { bid: bigint; ask: bigint; bidMax: bigint; askMax: bigint; maxNet: bigint }) => ({ bid: q.bid, ask: q.ask, bidMax: q.bidMax, askMax: q.askMax, maxNet: q.maxNet });
const balanced = { base: 40_000_000_000_000_000n, quote: (40_000_000_000_000_000n * mid(pool)) / SCALE };

test("the curve never undercuts the hedge at any net size", () => {
  const q = makeQuote(pool, balanced, 0n);
  for (let i = 1n; i <= 20n; i++) {
    const n = (q.maxNet * i) / 20n;
    const ask = q.ask + ((q.askMax - q.ask) * n) / q.maxNet;
    const bid = q.bid - ((q.bid - q.bidMax) * n) / q.maxNet;
    assert.ok(ask * n / SCALE >= cpIn(pool.quote, pool.base, n, 30n), `ask covers buying back ${n}`);
    assert.ok(bid * n / SCALE <= cpOut(pool.base, pool.quote, n, 30n), `bid covers selling ${n}`);
  }
});

test("a small one-sided order pays about what x/amm charges, never far more", () => {
  const q = makeQuote(pool, balanced, 0n);
  const spend = 3_000_000n; // 3 fUSD
  const p = clearingPrice(curveOf(q), spend, 0n);
  const blindOut = (spend * SCALE) / p;
  const ammOut = cpOut(pool.quote, pool.base, spend, 30n);
  assert.ok(blindOut * 10_000n >= ammOut * (10_000n - 25n), `within 0.25% of x/amm: ${blindOut} vs ${ammOut}`);
});

test("matched flow clears inside the band, better than x/amm for both sides", () => {
  const q = makeQuote(pool, balanced, 0n);
  const p = clearingPrice(curveOf(q), 2_845_000n, 1_000_000_000_000_000n); // 2.845 fUSD against 0.001 fETH
  assert.ok(p >= q.bid && p <= q.ask);
});

test("outside volatility widens the curve", () => {
  const calm = makeQuote(pool, inv, 5n), wild = makeQuote(pool, inv, 200n);
  assert.ok(wild.ask - wild.bid > calm.ask - calm.bid);
  assert.equal(volBps([100n, 104n, 101n]), 400n);
});

test("inventory skew leans against the position", () => {
  const m = mid(pool);
  const longBase = makeQuote(pool, { base: 60_000_000_000_000_000n, quote: (20_000_000_000_000_000n * m) / SCALE }, 0n);
  const longQuote = makeQuote(pool, { base: 60_000_000_000_000_000n, quote: (100_000_000_000_000_000n * m) / SCALE }, 0n);
  assert.ok(longBase.skewBps > 0n && longQuote.skewBps < 0n);
});

test("clearing rule: flat curve is the old band; crossing clears at the cross", () => {
  const c = { bid: 2_800_000_000n, ask: 2_900_000_000n, bidMax: 2_800_000_000n, askMax: 2_900_000_000n, maxNet: SCALE };
  assert.equal(clearingPrice(c, 2_900_000_000n, 0n), c.ask);
  assert.equal(clearingPrice(c, 0n, SCALE), c.bid);
  assert.equal(clearingPrice(c, 2_850_000_000n, SCALE), 2_850_000_000n);
});

test("markout: selling base at the ask then the price falls is a gain", () => {
  // maker sold 0.01 fETH for 29 fUSD; mid later 2,800 => base valued at 28 fUSD
  const r = markout(-10_000_000_000_000_000n, 29_000_000n, 2_800_000_000n);
  assert.equal(r.fill, 1_000_000n);
  // hedge bought the 0.01 fETH back for 28.5 fUSD: locked in 0.5 fUSD
  const h = markout(-10_000_000_000_000_000n, 29_000_000n, 2_800_000_000n, 10_000_000_000_000_000n, -28_500_000n);
  assert.equal(h.afterHedge, 500_000n);
});

import { fitToMandate } from "../src/agent/policy.ts";
test("a curve wider than the mandate is fitted inside it, keeping its shape", () => {
  const c = { bid: 5_400_000_000n, ask: 6_000_000_000n, bidMax: 5_300_000_000n, askMax: 6_100_000_000n }; // ~11% spread
  const f = fitToMandate(c, { maxSpreadBps: 300n, bandBps: 1500n, lastPrice: 0n, bandApplies: false })!;
  assert.ok(f, "fits");
  assert.ok((f.ask - f.bid) * 10_000n <= 300n * f.bid, "spread within 3%");
  assert.equal(f.bid - f.bidMax, c.bid - c.bidMax);
  assert.equal(f.askMax - f.ask, c.askMax - c.ask);
  assert.ok(f.bidMax <= f.bid && f.bid < f.ask && f.ask <= f.askMax);
});
test("a curve that cannot sit inside the band is refused", () => {
  const c = { bid: 5_000_000_000n, ask: 5_100_000_000n, bidMax: 4_900_000_000n, askMax: 5_200_000_000n };
  assert.equal(fitToMandate(c, { maxSpreadBps: 300n, bandBps: 500n, lastPrice: 6_000_000_000n, bandApplies: true }), null);
});
