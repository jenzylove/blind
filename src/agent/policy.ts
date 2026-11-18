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

export const DEFAULTS: PolicyParams = { marginBps: 15n, volMultiplier: 100n, skewBps: 40n, hedgeImpactBps: 100n, inventoryShare: 4_000n };

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
  bid: bigint; ask: bigint; maxNet: bigint; mid: bigint;
  hedgeAsk: bigint; hedgeBid: bigint; // what hedging maxNet on x/amm would cost, per base unit
  marginBps: bigint; skewBps: bigint; volBps: bigint;
}

/**
 * The quote the agent commits before any order can be read.
 * ask covers buying maxNet back from x/amm; bid covers selling it there; both widened by the
 * margin and by recent volatility, then shifted against the inventory imbalance.
 */
export function makeQuote(pool: Pool, inv: Inventory, recentMids: bigint[], prm: PolicyParams = DEFAULTS): Quote {
  const m = mid(pool);
  const maxNet = maxNetSize(pool, inv, prm);
  if (maxNet === 0n) throw new Error("no size available: inventory empty or pool too thin");
  // Cost to buy maxNet base from the pool (the maker's hedge after selling it), per unit.
  const hedgeAsk = (cpIn(pool.quote, pool.base, maxNet, pool.feeBps) * SCALE) / maxNet;
  // Proceeds from selling maxNet base into the pool (the hedge after buying it), per unit.
  const hedgeBid = (cpOut(pool.base, pool.quote, maxNet, pool.feeBps) * SCALE) / maxNet;
  const v = volBps(recentMids);
  const margin = prm.marginBps + (v * prm.volMultiplier) / 100n;
  const skew = (imbalanceBps(inv, m) * prm.skewBps) / BPS; // long base -> shade both down to sell it
  const ask = (hedgeAsk * (BPS + margin - skew)) / BPS;
  const bid = (hedgeBid * (BPS - margin - skew)) / BPS;
  if (!(bid > 0n && bid < ask)) throw new Error("degenerate quote");
  return { bid, ask, maxNet, mid: m, hedgeAsk, hedgeBid, marginBps: margin, skewBps: skew, volBps: v };
}

/** Same clearing rule as BlindSettlement.clearingPrice. */
export function clearingPrice(bid: bigint, ask: bigint, quoteIn: bigint, baseIn: bigint): bigint {
  if (quoteIn === 0n && baseIn === 0n) return 0n;
  if ((quoteIn * SCALE) / ask > baseIn) return ask;
  if ((quoteIn * SCALE) / bid < baseIn) return bid;
  const p = (quoteIn * SCALE) / baseIn;
  return p < bid ? bid : p > ask ? ask : p;
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
