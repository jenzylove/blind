import { test } from "node:test";
import assert from "node:assert/strict";
import { cpIn, cpOut, impactBps, makeQuote, maxNetSize, volBps, imbalanceBps, clearingPrice, markout, mid, DEFAULTS, SCALE, type Pool } from "../src/agent/policy.ts";

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

test("the band covers the hedge: ask above the pool's buy cost, bid below its sell proceeds", () => {
  const q = makeQuote(pool, { base: 40_000_000_000_000_000n, quote: (40_000_000_000_000_000n * mid(pool)) / SCALE }, []);
  assert.ok(q.ask > q.hedgeAsk && q.hedgeAsk > q.mid);
  assert.ok(q.bid < q.hedgeBid && q.hedgeBid < q.mid);
});

test("volatility widens the band", () => {
  const calm = makeQuote(pool, inv, [2_845_000_000n, 2_846_000_000n]);
  const wild = makeQuote(pool, inv, [2_845_000_000n, 2_960_000_000n]);
  assert.ok(wild.ask - wild.bid > calm.ask - calm.bid);
  assert.equal(volBps([100n, 104n, 101n]), 400n);
});

test("inventory skew leans against the position", () => {
  const m = mid(pool);
  const longBase = makeQuote(pool, { base: 60_000_000_000_000_000n, quote: (20_000_000_000_000_000n * m) / SCALE }, []);
  const longQuote = makeQuote(pool, { base: 60_000_000_000_000_000n, quote: (100_000_000_000_000_000n * m) / SCALE }, []);
  assert.ok(imbalanceBps({ base: 60_000_000_000_000_000n, quote: (20_000_000_000_000_000n * m) / SCALE }, m) > 0n);
  // long base: cheaper ask to sell it off; long quote: higher bid to buy base
  assert.ok(longBase.skewBps > 0n && longQuote.skewBps < 0n);
});

test("clearing rule matches the contract", () => {
  const bid = 2_800_000_000n, ask = 2_900_000_000n;
  assert.equal(clearingPrice(bid, ask, 2_900_000_000n, 0n), ask);
  assert.equal(clearingPrice(bid, ask, 0n, SCALE), bid);
  assert.equal(clearingPrice(bid, ask, 2_850_000_000n, SCALE), 2_850_000_000n);
});

test("markout: selling base at the ask then the price falls is a gain", () => {
  // maker sold 0.01 fETH for 29 fUSD; mid later 2,800 => base valued at 28 fUSD
  const r = markout(-10_000_000_000_000_000n, 29_000_000n, 2_800_000_000n);
  assert.equal(r.fill, 1_000_000n);
  // hedge bought the 0.01 fETH back for 28.5 fUSD: locked in 0.5 fUSD
  const h = markout(-10_000_000_000_000_000n, 29_000_000n, 2_800_000_000n, 10_000_000_000_000_000n, -28_500_000n);
  assert.equal(h.afterHedge, 500_000n);
});
