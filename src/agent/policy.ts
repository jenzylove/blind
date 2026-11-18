// Blind's market maker policy. Pure functions, no network.
//
// Units: base = fETH (18 decimals), quote = fUSD (6 decimals).
// A price is fUSD base units per fETH base unit, times 1e18 (the contract's PRICE_SCALE),
// so 2,800 fUSD per fETH is 2_800e6.

export const SCALE = 10n ** 18n;
export const BPS = 10_000n;

export interface Pool { base: bigint; quote: bigint; feeBps: bigint; maxImpactBps: bigint }
export interface Inventory { base: bigint; quote: bigint } // contract stock plus hedger balance
export interface PolicyParams {
  marginBps: bigint;        // edge kept on top of the hedge cost
  volMultiplier: bigint;    // extra margin per bp of recent mid move, in hundredths (100 = 1x)
  skewBps: bigint;          // price shift at 100% inventory imbalance
  hedgeImpactBps: bigint;   // largest hedge impact the agent will accept (under the chain cap)
  inventoryShare: bigint;   // max share of either inventory side one batch may move, in bps
}

export const DEFAULTS: PolicyParams = { marginBps: 15n, volMultiplier: 100n, skewBps: 40n, hedgeImpactBps: 250n, inventoryShare: 4_000n };

export const mid = (p: Pool) => (p.quote * SCALE) / p.base;

/** Constant product exact-in output after the pool fee (what x/amm pays). */
export function cpOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint): bigint {
  const inAfterFee = (amountIn * (BPS - feeBps)) / BPS;
  return (reserveOut * inAfterFee) / (reserveIn + inAfterFee);
}

/** Constant product exact-out input including the pool fee (what x/amm charges). */
export function cpIn(reserveIn: bigint, reserveOut: bigint, amountOut: bigint, feeBps: bigint): bigint {
  if (amountOut >= reserveOut) return 2n ** 255n;
  const raw = (reserveIn * amountOut) / (reserveOut - amountOut) + 1n;
  return (raw * BPS) / (BPS - feeBps) + 1n;
}

/** Price impact in bps of trading `amount` of the input side, as x/amm measures it against its price. */
export function impactBps(reserveIn: bigint, amountIn: bigint): bigint {
  return (amountIn * BPS) / (reserveIn + amountIn);
}

/** The largest base size whose hedge stays under the impact limit and the inventory share. */
export function maxNetSize(pool: Pool, inv: Inventory, prm: PolicyParams): bigint {
  const limit = prm.hedgeImpactBps < pool.maxImpactBps ? prm.hedgeImpactBps : pool.maxImpactBps - 50n;
  // impact = x / (R + x) <= L/BPS  =>  x <= R * L / (BPS - L)
  const byImpact = (pool.base * limit) / (BPS - limit);
  const m = mid(pool);
  const byBase = (inv.base * prm.inventoryShare) / BPS;
  const byQuote = m === 0n ? 0n : ((inv.quote * prm.inventoryShare) / BPS) * SCALE / m;
  return [byImpact, byBase, byQuote].reduce((a, b) => (a < b ? a : b));
}

/** Recent volatility: the largest absolute mid move between consecutive samples, in bps. */
export function volBps(mids: bigint[]): bigint {
  let v = 0n;
  for (let i = 1; i < mids.length; i++) {
    const d = mids[i] > mids[i - 1] ? mids[i] - mids[i - 1] : mids[i - 1] - mids[i];
    const b = (d * BPS) / mids[i - 1];
    if (b > v) v = b;
  }
  return v;
}

/** Inventory imbalance in bps, -BPS..BPS. Positive = holding more base value than quote value. */
export function imbalanceBps(inv: Inventory, m: bigint): bigint {
  const baseValue = (inv.base * m) / SCALE;
  const total = baseValue + inv.quote;
  if (total === 0n) return 0n;
  return ((baseValue - inv.quote) * BPS) / total;
}

export interface Quote {
  bid: bigint; ask: bigint; bidMax: bigint; askMax: bigint; maxNet: bigint; mid: bigint;
  marginBps: bigint; skewBps: bigint; volBps: bigint;
}

/**
 * The curve the agent commits before any order can be read.
 * Each end is what hedging that size on x/amm would cost, per base unit: a tiny size for
 * (bid, ask), the full maxNet for (bidMax, askMax). The hedge's average cost grows convexly
 * with size, so the straight line between the ends never undercuts it. Both ends are widened
 * by the margin plus recent outside volatility, then shifted against the inventory imbalance.
 * `extMoveBps` is the largest recent pool move NOT caused by our own hedges.
 */
export function makeQuote(pool: Pool, inv: Inventory, extMoveBps: bigint, prm: PolicyParams = DEFAULTS): Quote {
  const m = mid(pool);
  const maxNet = maxNetSize(pool, inv, prm);
  if (maxNet === 0n) throw new Error("no size available: inventory empty or pool too thin");
  const tiny = maxNet / 1000n > 0n ? maxNet / 1000n : 1n;
  const buyCost = (n: bigint) => (cpIn(pool.quote, pool.base, n, pool.feeBps) * SCALE) / n;     // maker sold n, buys it back
  const sellGain = (n: bigint) => (cpOut(pool.base, pool.quote, n, pool.feeBps) * SCALE) / n;   // maker bought n, sells it
  const margin = prm.marginBps + (extMoveBps * prm.volMultiplier) / 100n;
  const skew = (imbalanceBps(inv, m) * prm.skewBps) / BPS; // long base -> shade down to sell it
  const up = (x: bigint) => (x * (BPS + margin - skew)) / BPS;
  const dn = (x: bigint) => (x * (BPS - margin - skew)) / BPS;
  const q = { bid: dn(sellGain(tiny)), ask: up(buyCost(tiny)), bidMax: dn(sellGain(maxNet)), askMax: up(buyCost(maxNet)) };
  if (!(q.bidMax > 0n && q.bidMax <= q.bid && q.bid < q.ask && q.ask <= q.askMax)) throw new Error("degenerate curve");
  return { ...q, maxNet, mid: m, marginBps: margin, skewBps: skew, volBps: extMoveBps };
}

function isqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let z = x, y = (x >> 1n) + 1n;
  while (y < z) { z = y; y = (x / y + y) >> 1n; }
  return z;
}

function solve(p0: bigint, d: bigint, m: bigint, q: bigint, b: bigint): bigint {
  if (d === 0n) return p0;
  const lin = p0 * m - d * b;
  const root = isqrt(lin * lin + 4n * m * d * q * SCALE);
  const p = (lin + root) / (2n * m);
  return p > 0n ? p : 1n;
}

export interface Curve { bid: bigint; ask: bigint; bidMax: bigint; askMax: bigint; maxNet: bigint }

/** Same rule as BlindSettlement.clearingPrice: the exact fixed point on the committed curve. */
export function clearingPrice(c: Curve, quoteIn: bigint, baseIn: bigint): bigint {
  if (quoteIn === 0n && baseIn === 0n) return 0n;
  if ((quoteIn * SCALE) / c.ask > baseIn) {
    const p = solve(c.ask, c.askMax - c.ask, c.maxNet, quoteIn, baseIn);
    return p < c.ask ? c.ask : p > c.askMax ? c.askMax : p;
  }
  if ((quoteIn * SCALE) / c.bid < baseIn) {
    const p = solve(c.bid, c.bid - c.bidMax, c.maxNet, quoteIn, baseIn);
    return p > c.bid ? c.bid : p < c.bidMax ? c.bidMax : p;
  }
  const p = (quoteIn * SCALE) / baseIn;
  return p < c.bid ? c.bid : p > c.ask ? c.ask : p;
}

/**
 * Markout: the maker's result valued at a later pool mid, in fUSD base units.
 * makerBase/makerQuote are the contract's Settled values (positive = received).
 * hedgeBase/hedgeQuote are the hedger's balance changes from its x/amm swap (0 if none).
 */
export function markout(makerBase: bigint, makerQuote: bigint, laterMid: bigint, hedgeBase = 0n, hedgeQuote = 0n) {
  const fill = makerQuote + (makerBase * laterMid) / SCALE;
  const afterHedge = fill + hedgeQuote + (hedgeBase * laterMid) / SCALE;
  return { fill, afterHedge };
}
