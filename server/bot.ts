// A real sandwich bot on QoreChain testnet, run so anyone can see what happens to a public swap.
// It has its own account and reads only the public mempool (`unconfirmed_txs`). It never sees sealed
// Blind orders in the clear, because nothing in the mempool shows them. It attacks every public
// MsgSwapExactIn on pool 3, not only demo users: it front-runs with a higher fee, sized so the victim
// still just clears their own minimum, then sells back after the victim's swap lands.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { StargateClient } from "@cosmjs/stargate";
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { EthNativeSigner, resolveSignBytesVersion, type UnifiedAccount } from "@qorechain/sdk";
import { NET, denom, registry } from "../src/chain.ts";
import { readPool, POOL_ID } from "../src/engine/batch.ts";
import { cpOut } from "../src/agent/policy.ts";

const RPC = NET.rpc;
const SWAP = "/qorechain.amm.v1.MsgSwapExactIn";
const FEE_UQOR = 500_000; // 10x the normal fee: QoreChain orders a block by fee
const NORMAL_FEE = 50_000;
const MAX_IMPACT_BPS = 480n; // x/amm refuses a swap over 5% impact; stay under it
const MIN_PROFIT = 20_000n; // 0.02 fUSD-equivalent units in the victim's input token, else skip

export interface Attempt {
  victimHash: string; victim: string; side: "buy" | "sell"; amountIn: string; minOut: string; at: string;
  seenMs: number; frontHash?: string; frontIn?: string; backHash?: string;
  victimHeight?: number; frontHeight?: number; order?: "bot first" | "victim first" | "missed the block";
  victimGot?: string; victimWouldGet?: string; victimLossBps?: number; botPnl?: string; botPnlDenom?: string;
  skipped?: string; error?: string;
}

export class SandwichBot {
  attempts: Attempt[] = [];
  private seen = new Set<string>();
  private seq = { accountNumber: 0, sequence: 0, at: 0 };
  private client?: StargateClient;
  private signBytesVersion: any;
  private busy = false;
  // Kept fresh in the background so an attack costs only a signature, not a round trip.
  private pool?: Awaited<ReturnType<typeof readPool>>;
  private bal: Record<string, bigint> = {};
  log: (s: string) => void = (s) => console.log(`[bot] ${s}`);

  constructor(public acc: UnifiedAccount, private store: string, private skip: string[] = []) {
    if (existsSync(store)) this.attempts = JSON.parse(readFileSync(store, "utf8"));
    for (const a of this.attempts) this.seen.add(a.victimHash);
  }

  private save() { writeFileSync(this.store, JSON.stringify(this.attempts.slice(-500), null, 1)); }

  async start() {
    this.client = await StargateClient.connect(RPC);
    this.signBytesVersion = await resolveSignBytesVersion({ chainId: NET.chainId, rest: NET.rest } as any);
    await this.refreshSeq();
    const refresh = async () => {
      try {
        this.pool = await readPool();
        for (const d of [denom("fUSD"), denom("fETH")]) this.bal[d] = await this.balance(d);
      } catch { /* keep the last values */ }
      setTimeout(refresh, 1500);
    };
    await refresh();
    const tick = async () => {
      try { await this.poll(); } catch (e: any) { this.log(`poll: ${String(e.message).slice(0, 120)}`); }
      setTimeout(tick, 40);
    };
    tick();
    this.log(`watching the public mempool as ${this.acc.cosmos}`);
  }

  private async refreshSeq() {
    const r = (await (await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${this.acc.cosmos}`)).json()) as any;
    const a = r.account.base_account ?? r.account;
    this.seq = { accountNumber: Number(a.account_number), sequence: Number(a.sequence), at: Date.now() };
  }

  private async sign(msg: any, fee: number) {
    const signer = new EthNativeSigner(this.acc, { signMode: "hybrid", rest: NET.rest, registry } as any);
    const { txRawBytes } = await (signer as any).sign({ chainId: NET.chainId, accountNumber: this.seq.accountNumber, sequence: this.seq.sequence,
      signBytesVersion: this.signBytesVersion, fee: { amount: [{ denom: "uqor", amount: String(fee) }], gas: "400000" }, messages: [msg] });
    this.seq.sequence++;
    return txRawBytes as Uint8Array;
  }

  private async poll() {
    if (this.busy) return;
    const r = (await (await fetch(`${RPC}/unconfirmed_txs?limit=100`)).json()) as any;
    for (const b64 of r.result?.txs ?? []) {
      const raw = Buffer.from(b64, "base64");
      const hash = createHash("sha256").update(raw).digest("hex").toUpperCase();
      if (this.seen.has(hash)) continue;
      this.seen.add(hash);
      let msg: any;
      try {
        const tx = decodeTxRaw(raw);
        const any = tx.body.messages.find((m) => m.typeUrl === SWAP);
        if (!any) continue;
        msg = registry.decode(any);
      } catch { continue; }
      if (String(msg.poolId) !== POOL_ID || msg.sender === this.acc.cosmos || this.skip.includes(msg.sender)) continue;
      this.busy = true;
      this.attack(hash, msg).catch((e) => this.log(`attack ${hash.slice(0, 8)}: ${e.message}`)).finally(() => { this.busy = false; });
      return;
    }
  }

  private async attack(victimHash: string, m: any) {
    const t0 = Date.now();
    const F = denom("fUSD"), E = denom("fETH");
    const buy = m.tokenIn.denom === F; // victim pays fUSD for fETH
    const a: Attempt = { victimHash, victim: m.sender, side: buy ? "buy" : "sell", amountIn: String(m.tokenIn.amount), minOut: String(m.minOut), at: new Date().toISOString(), seenMs: 0 };
    this.attempts.push(a);
    const pool = this.pool ?? (await readPool());
    const [rIn, rOut] = buy ? [pool.quote, pool.base] : [pool.base, pool.quote];
    const vIn = BigInt(m.tokenIn.amount), vMin = BigInt(m.minOut);
    const wouldGet = cpOut(rIn, rOut, vIn, 30n);
    a.victimWouldGet = wouldGet.toString();
    // Largest front-run x that still lets the victim clear their minimum (so their swap goes through).
    const victimAfter = (x: bigint) => { const out = cpOut(rIn, rOut, x, 30n); return cpOut(rIn + x, rOut - out, vIn, 30n); };
    const cap = (rIn * MAX_IMPACT_BPS) / 10_000n;
    let lo = 0n, hi = cap;
    for (let i = 0; i < 60 && hi - lo > 1n; i++) { const mid = (lo + hi) / 2n; if (victimAfter(mid) >= (vMin * 1002n) / 1000n) lo = mid; else hi = mid; }
    const bal = this.bal[buy ? F : E] ?? 0n;
    const x = lo < bal ? lo : bal;
    // Expected profit: buy x, the victim pushes the price further, sell back.
    const got = cpOut(rIn, rOut, x, 30n);
    const back = cpOut(rOut - got - victimAfter(x), rIn + x + vIn, got, 30n);
    if (x === 0n || back - x < MIN_PROFIT) { a.skipped = x === 0n ? "the victim's limit leaves nothing to take" : "not worth the fees"; this.save(); return; }
    const front = await this.sign({ typeUrl: SWAP, value: { sender: this.acc.cosmos, poolId: POOL_ID, tokenIn: { denom: buy ? F : E, amount: x.toString() }, denomOut: buy ? E : F, minOut: "0" } }, FEE_UQOR);
    const fr = await this.client!.broadcastTxSync(front);
    a.seenMs = Date.now() - t0; a.frontHash = fr.toString(); a.frontIn = x.toString();
    this.log(`front-ran ${victimHash.slice(0, 8)} with ${x} in ${a.seenMs} ms`);
    const [v, f] = await Promise.all([this.result(victimHash), this.result(a.frontHash)]);
    a.victimHeight = v?.height; a.frontHeight = f?.height;
    if (v) a.victimGot = this.received(v.events, m.sender, buy ? E : F).toString();
    if (v && f) {
      if (f.height < v.height) a.order = "bot first";
      else if (f.height > v.height) a.order = "missed the block";
      else { const order = await this.blockOrder(v.height); a.order = order.indexOf(a.frontHash) < order.indexOf(victimHash) ? "bot first" : "victim first"; }
    }
    if (a.victimGot && wouldGet > 0n) a.victimLossBps = Number(((wouldGet - BigInt(a.victimGot)) * 10_000n) / wouldGet);
    // Sell back whatever the front-run bought.
    const bought = f ? this.received(f.events, this.acc.cosmos, buy ? E : F) : 0n;
    if (bought > 0n) {
      const bk = await this.sign({ typeUrl: SWAP, value: { sender: this.acc.cosmos, poolId: POOL_ID, tokenIn: { denom: buy ? E : F, amount: bought.toString() }, denomOut: buy ? F : E, minOut: "0" } }, NORMAL_FEE);
      a.backHash = (await this.client!.broadcastTxSync(bk)).toString();
      const k = await this.result(a.backHash);
      if (k) { const ret = this.received(k.events, this.acc.cosmos, buy ? F : E); a.botPnl = (ret - x).toString(); a.botPnlDenom = buy ? "fUSD" : "fETH"; }
    }
    if (!f || f.code) { a.error = f?.log?.slice(0, 160) ?? "front-run not included"; await this.refreshSeq(); }
    await this.refreshSeq();
    this.log(`${victimHash.slice(0, 8)}: ${a.order}, victim lost ${a.victimLossBps ?? "?"} bps, bot ${a.botPnl ?? "?"} ${a.botPnlDenom ?? ""}`);
    this.save();
  }

  private async balance(d: string) {
    const r = (await (await fetch(`${NET.rest}/cosmos/bank/v1beta1/balances/${this.acc.cosmos}/by_denom?denom=${encodeURIComponent(d)}`)).json()) as any;
    return BigInt(r.balance?.amount ?? 0);
  }

  private async result(hash: string) {
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
      if (r.ok) { const b = (await r.json()) as any; return { height: Number(b.tx_response.height), code: b.tx_response.code as number, log: b.tx_response.raw_log as string, events: b.tx_response.events as any[] }; }
      await new Promise((ok) => setTimeout(ok, 600));
    }
    return null;
  }

  private async blockOrder(height: number): Promise<string[]> {
    const b = (await (await fetch(`${RPC}/block?height=${height}`)).json()) as any;
    return (b.result.block.data.txs ?? []).map((t: string) => createHash("sha256").update(Buffer.from(t, "base64")).digest("hex").toUpperCase());
  }

  private received(ev: any[], who: string, d: string) {
    return ev.filter((e) => e.type === "coin_received").flatMap((e) => {
      const at = Object.fromEntries(e.attributes.map((x: any) => [x.key, x.value]));
      return at.receiver === who && String(at.amount).endsWith(d) ? [BigInt(String(at.amount).slice(0, -d.length))] : [];
    }).reduce((p, q) => p + q, 0n);
  }

  /** Hit rate and totals, for the site. */
  stats() {
    const tried = this.attempts.filter((a) => a.frontHash);
    const hits = tried.filter((a) => a.order === "bot first");
    return {
      account: this.acc.cosmos, tried: tried.length, hits: hits.length,
      avgLossBps: hits.length ? Math.round(hits.reduce((s, a) => s + (a.victimLossBps ?? 0), 0) / hits.length) : null,
      recent: [...this.attempts].reverse().slice(0, 30),
    };
  }
  find(victimHash: string) { return this.attempts.find((a) => a.victimHash === victimHash.toUpperCase()) ?? null; }
}
