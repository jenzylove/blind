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
  batch: number; live?: boolean; startedAt?: string; endedAt?: string;
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
  live: BatchRec[]; testRuns: BatchRec[];
  versions: { current: { contract: string; version: number }; previous: { contract: string } | null };
}
export interface Quote { side: string; amountIn: string; mid: string; blindIfAlone: string; withinMakerSize: boolean; plainAmm: string | null; ammRefused: boolean }

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((body as any).error ?? `HTTP ${r.status}`), { status: r.status });
  return body as T;
}
const post = (url: string, b: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

export const api = {
  state: () => j<State>("/api/state"),
  batches: () => j<Batches>("/api/batches"),
  batchesV1: () => j<BatchRec[]>("/api/batches/v1"),
  batch: (id: number) => j<BatchRec>(`/api/batch/${id}`),
  quote: (side: "buy" | "sell", amount: bigint) => j<Quote>(`/api/quote?side=${side}&amount=${amount}`),
  me: (evm: string) => j<{ fUSD: string; fETH: string; approved: { fUSD: boolean; fETH: boolean } }>(`/api/me/${evm}`),
  account: (addr: string) => j<{ accountNumber: string; sequence: string }>(`/api/cosmos/account/${addr}`),
  pqc: (addr: string) => j<{ registered: boolean }>(`/api/cosmos/pqc/${addr}`),
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
