// The server's API, typed. Every number on screen comes from here.
export type Phase = "waiting" | "intake" | "quoting" | "opening" | "settling" | "hedging";

export interface State {
  chainId: string; evmChainId: number; evmRpc: string; contract: string;
  tokens: { fUSD: { address: string; decimals: number }; fETH: { address: string; decimals: number } };
  agent: string; settler: string; treasury: string; phase: Phase;
  batch: { id: number; taking: boolean; closesAt: number | null; publicKey: { mlkem: string; x25519: string } | null; created: boolean };
  standingKey: { mlkem: string; x25519: string };
  pool: { id: number; base: string; quote: string; mid: string };
  standingOpen: number;
}

export interface Tx { hash: string; block: number; gas?: number; bytes?: number }
export interface Fill { user: string; orderHash?: string; buy: boolean; amountIn: string; amountOut: string; plainAmm: string; standing?: boolean }
export interface BatchRec {
  batch: number; version?: number; contract?: string; live?: boolean; startedAt?: string; endedAt?: string;
  create?: Tx; posts?: Tx[];
  commit?: Tx & { bid: string; ask: string; bidMax?: string; askMax?: string; maxNet: string; mid: string; marginBps?: string; skewBps?: string; volBps?: string; hedgeAsk?: string; hedgeBid?: string };
  open?: Tx; opened?: number;
  settled?: boolean; settle?: Tx & { price: string; makerBase: string; makerQuote: string };
  fills?: Fill[]; dropped?: { user: string; reason: string }[];
  hedge?: { hash?: string; height?: number; skipped?: string; failed?: string; baseDelta?: string; quoteDelta?: string };
  markout?: { block: number; mid: string; fill: string; afterHedge: string };
  curveVersion?: number; error?: string;
}
export interface Batches {
  live: BatchRec[]; testRuns: BatchRec[]; earlier?: BatchRec[];
  versions: { current: { contract: string; version: number }; previous: { contract: string } | null };
}
/** The first 80 bytes (160 hex chars) of the newest sealed order, read back from its Sealed event. */
export interface Envelope { batch: number; version: number; txHash: string; bytes: number; hexHead: string }
export interface Quote { side: string; amountIn: string; mid: string; blindIfAlone: string; withinMakerSize: boolean; plainAmm: string | null; ammRefused: boolean }

/** The pool price over time and each settled batch's price. Prices are fUSD per fETH; times are ms. */
export interface Market { mid: number | null; since: number | null; series: [number, number][]; batches: [number, number, number?][] }
/** The open batch as the chain shows it: sealed orders by size and time, and the locked price once there is one. */
export interface CurrentBatch {
  id: number | null; phase: Phase; closesAt: number | null;
  posts: { hash: string; block: number; bytes: number | null; at: number | null }[];
  commit: { block: number; bid: string; ask: string } | null;
}

/** How far this device's clock is from the server's, in ms, read from response headers. Countdowns add it. */
let skew = 0;
export const clockSkew = () => skew;

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const t0 = Date.now();
  const r = await fetch(url, init);
  const d = Date.parse(r.headers.get("date") ?? "");
  // The header has whole seconds, so small gaps are noise; only a clock that is really off is corrected.
  if (Number.isFinite(d)) { const off = d + 500 - (t0 + Date.now()) / 2; skew = Math.abs(off) > 2500 ? off : 0; }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((body as any).error ?? `HTTP ${r.status}`), { status: r.status });
  return body as T;
}
const post = (url: string, b: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

export const api = {
  state: () => j<State>("/api/state"),
  batches: () => j<Batches>("/api/batches"),
  batchesV1: () => j<BatchRec[]>("/api/batches/v1"),
  market: () => j<Market>("/api/market"),
  currentBatch: () => j<CurrentBatch>("/api/batch/current"),
  agent: () => j<AgentInfo>("/api/agent"),
  bot: () => j<BotStats>("/api/bot"),
  /** The first bytes of the newest sealed order posted on chain (404 until there is one). */
  envelope: () => j<Envelope>("/api/envelope/latest"),
  /** The bot's record of one public swap, or null until the bot has seen it. Read from /api/bot so a miss is not a 404. */
  botAttempt: async (victimHash: string): Promise<Attempt | null> => {
    const b = await j<BotStats>("/api/bot");
    const h = victimHash.toUpperCase();
    const a = b.recent.find((x) => x.victimHash === h);
    if (a || b.recent.length < 30) return a ?? null;
    // Pushed off the recent list by newer swaps: ask for it directly.
    const r = await fetch(`/api/bot/attempt/${h}`);
    return r.ok ? r.json() : null;
  },
  batch: (id: number, v?: number) => j<BatchRec>(`/api/batch/${id}${v ? `?v=${v}` : ""}`),
  quote: (side: "buy" | "sell", amount: bigint) => j<Quote>(`/api/quote?side=${side}&amount=${amount}`),
  me: (evm: string) => j<{ fUSD: string; fETH: string; approved: { fUSD: boolean; fETH: boolean } }>(`/api/me/${evm}`),
  account: (addr: string) => j<{ accountNumber: string; sequence: string }>(`/api/cosmos/account/${addr}`),
  pqc: (addr: string) => j<{ registered: boolean; possessionProven?: boolean }>(`/api/cosmos/pqc/${addr}`),
  window: (addr: string) => j<any>(`/api/cosmos/window/${addr}`),
  cosmosTx: (hash: string) => j<{ found: boolean; code?: number; height?: number; log?: string }>(`/api/cosmos/tx/${hash}`),
  broadcast: async (tx_bytes: string) => (await post("/api/cosmos/broadcast", { tx_bytes })).json() as Promise<{ hash?: string; code?: number; log?: string }>,
  fund: async (cosmos: string, evm: string) => {
    const r = await post("/api/fund", { cosmos, evm });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? "The faucet did not answer.");
    return b as { hash: string };
  },
  order: async (envelope: string) => { const r = await post("/api/order", { envelope }); return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }; },
  limit: async (envelope: string) => { const r = await post("/api/limit", { envelope }); return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }; },
};

/** The agent's linked key and the spending rule the chain enforces on it (read live from chain). */
export interface AgentInfo {
  account: string;
  settlement: string;
  linked: boolean;
  key: { pubkeyHex: string; expiryUnix: string; label: string; revoked: boolean; permissions: string[] } | null;
  rules: { rules: { id: string; perTxLimit: string; dailyLimit: string; allowedDenoms: string[]; enabled: boolean; allowedEvmCalls: string[] }[] };
}

/** One public swap the bot saw in the mempool, and what it did. */
export interface Attempt {
  victimHash: string; victim: string; side: "buy" | "sell"; amountIn: string; minOut: string; at: string;
  seenMs: number; frontHash?: string; frontIn?: string; backHash?: string;
  victimHeight?: number; frontHeight?: number; order?: "bot first" | "victim first" | "missed the block";
  victimGot?: string; victimWouldGet?: string; victimLossBps?: number; botPnl?: string; botPnlDenom?: string;
  skipped?: string; error?: string;
}
export interface BotStats { account: string; tried: number; hits: number; avgLossBps: number | null; recent: Attempt[] }

/** The contract version the app trades on now. Each version numbers its batches from 1. */
export const CURRENT_VERSION = 3;
/** Link to a batch's page, naming the contract version when it is not the current one. */
export const batchPath = (r: { batch: number; version?: number }) =>
  `/batch/${r.batch}${r.version && r.version !== CURRENT_VERSION ? `?v=${r.version}` : ""}`;
