// The live batch loop behind the web app.
// A batch exists on chain only when someone trades: the next batch's public sealing key is
// published ahead of time (its seed stays secret, its hash goes on chain at create), the first
// sealed order creates the batch, intake closes INTAKE_MS later, then the agent commits its
// curve, the seed is revealed in a later block, orders are opened from chain logs, settled
// in one transaction and hedged on x/amm.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { decodeAbiParameters, keccak256, toHex, hexToBytes, type Hex } from "viem";
import { pqcSign, type UnifiedAccount } from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";
import { open as openEnvelope, sealKeysFromSeed, recipientOf } from "@qorechain/qoreseal";
import { pub, send, windowMsg, NET, artifact } from "../src/chain.ts";
import { Engine, readPool, makerInventory, ORDER_T, type Order } from "../src/engine/batch.ts";
import { makeQuote, clearingPrice, markout, SCALE, type Curve } from "../src/agent/policy.ts";

const { abi } = artifact("BlindSettlement");
const INTAKE_MS = Number(process.env.INTAKE_MS ?? 20_000);
const DATA = process.env.DATA_DIR ?? "data";
const STORE = `${DATA}/batches.json`;
const purposeOf = (settlement: string, id: bigint | number) => `blind-order-v1:${settlement.toLowerCase()}:${id}`;
export const STANDING_PURPOSE = (settlement: string) => `blind-standing-v1:${settlement.toLowerCase()}`;

export type Phase = "waiting" | "intake" | "quoting" | "opening" | "settling" | "hedging";

interface Pending { seed: Uint8Array; publicKey: { mlkem: string; x25519: string } }
interface Standing { o: Order; sig: Hex; postedTx: string; hash: string }

export class BatchLoop {
  phase: Phase = "waiting";
  current: { id: number; createdBlock: number; closesAt: number; seed: Uint8Array; posts: any[] } | null = null;
  next: Pending;
  standing: Standing[] = [];
  records: any[] = [];
  history: any[] = []; // unattended test runs before the app went live (test trader accounts)
  private queue: Promise<unknown> = Promise.resolve();
  private extMoves: bigint[] = [];
  private lastMidAfter: bigint | null = null;
  private standingSeed: Uint8Array;
  log: (s: string) => void = (s) => console.log(`[loop] ${s}`);

  constructor(public engine: Engine, standingSeedHex: string) {
    mkdirSync(DATA, { recursive: true });
    // First boot on a fresh volume: start from the live batches recorded before the move.
    if (!existsSync(STORE) && existsSync("deployments/batches-live.json")) writeFileSync(STORE, readFileSync("deployments/batches-live.json"));
    if (existsSync(STORE)) this.records = JSON.parse(readFileSync(STORE, "utf8"));
    if (existsSync("deployments/batches-curve.json")) this.history = JSON.parse(readFileSync("deployments/batches-curve.json", "utf8")).filter((r: any) => r.settled);
    this.next = this.freshKey();
    this.standingSeed = hexToBytes(standingSeedHex as Hex);
    if (this.standingSeed.length !== 32) throw new Error("STANDING_SEED must be 32 bytes hex");
  }

  get settlement() { return this.engine.settlement; }
  standingPublicKey() { return pk(sealKeysFromSeed(this.standingSeed)); }

  private freshKey(): Pending {
    const seed = new Uint8Array(randomBytes(32));
    return { seed, publicKey: pk(sealKeysFromSeed(seed)) };
  }

  /** Every settler transaction goes through one queue: one nonce stream, no races. */
  serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private save() {
    writeFileSync(STORE, JSON.stringify(this.records, null, 2));
  }

  /** Keep a scoped window open on the settler: target = the settlement contract only. */
  async ensureWindow() {
    const w = await evmWindowStatus({ rest: NET.rest, address: this.engine.settler.cosmos });
    const remainingTxs = Number((w as any).remainingTxs ?? (w as any).remaining_txs ?? 0);
    const remainingBlocks = Number((w as any).remainingBlocks ?? (w as any).remaining_blocks ?? 0);
    if (w.found && (w as any).live !== false && remainingTxs > 12 && remainingBlocks > 120) return;
    await send(this.engine.settler, "hybrid", [windowMsg(this.engine.settler, {
      blocks: 3000n, maxTxs: 300n, maxValueUqor: 300n * 110_000n, allowedTargets: [this.settlement],
    })], "settler window: 300 txs / 3000 blocks, target = BlindSettlement only");
    await new Promise((ok) => setTimeout(ok, 3000));
  }

  /** A user's sealed order for the current (or next) batch. Returns the post transaction. */
  async submit(envelope: Hex) {
    if (envelope.length > 2 + 2 * 8192) throw new Error("envelope too large");
    return this.serial(async () => {
      if (this.phase !== "waiting" && this.phase !== "intake") throw new Error("intake closed; seal to the next batch key and retry");
      await this.ensureWindow();
      if (!this.current) {
        const { seed, publicKey } = this.next;
        const c = await this.engine.tx("create", [keccak256(seed)]);
        const id = Number(await this.engine.read<bigint>("batchCount", []));
        this.current = { id, createdBlock: c.block, closesAt: Date.now() + INTAKE_MS, seed, posts: [], publicKey } as any;
        this.next = this.freshKey();
        this.phase = "intake";
        this.log(`batch ${id} created (block ${c.block}); intake closes in ${INTAKE_MS / 1000}s`);
        setTimeout(() => this.close().catch((e) => this.log(`batch ${id} failed: ${e.message}`)), INTAKE_MS);
        (this.current as any).create = c;
      }
      const p = await this.engine.tx("post", [BigInt(this.current.id), envelope]);
      this.current.posts.push(p);
      return { batch: this.current.id, hash: p.hash, block: p.block, closesAt: this.current.closesAt };
    });
  }

  /** A standing limit order, sealed to the standing key. Posted on chain in the current batch. */
  async submitStanding(envelope: Hex) {
    const keys = sealKeysFromSeed(this.standingSeed);
    const pt = openEnvelope({ chainId: NET.chainId, purpose: STANDING_PURPOSE(this.settlement), envelope: hexToBytes(envelope), keys });
    const [o, sig] = decodeAbiParameters(ORDER_T, toHex(pt)) as unknown as [Order, Hex];
    if (o.batch !== 0n) throw new Error("a standing order must have batch 0");
    const r = await this.submit(envelope);
    const hash = await this.engine.read<Hex>("orderHash", [o]);
    this.standing.push({ o, sig, postedTx: r.hash, hash });
    return { ...r, orderHash: hash };
  }

  private async close() {
    const cur = this.current!;
    const id = BigInt(cur.id);
    const rec: any = { batch: cur.id, live: true, startedAt: new Date(cur.closesAt - INTAKE_MS).toISOString(), create: (cur as any).create, posts: cur.posts, dropped: [], curveVersion: 2 };
    try {
      // Quote from public data only, before anything can be opened.
      this.phase = "quoting";
      const pool = await readPool();
      const now = (pool.quote * SCALE) / pool.base;
      if (this.lastMidAfter) this.extMoves.push(((now > this.lastMidAfter ? now - this.lastMidAfter : this.lastMidAfter - now) * 10_000n) / this.lastMidAfter);
      const ext = this.extMoves.slice(-5).reduce((a, b) => (b > a ? b : a), 0n);
      const inv = await makerInventory(this.settlement, this.engine.hedger);
      const q = makeQuote(pool, { base: inv.contract.base + inv.hedger.base, quote: inv.contract.quote + inv.hedger.quote }, ext);
      const curve: Curve = { bid: q.bid, ask: q.ask, bidMax: q.bidMax, askMax: q.askMax, maxNet: q.maxNet };
      const quoteExpiry = BigInt(Number(await pub.getBlockNumber()) + 300);
      const qmsg = await this.engine.read<Hex>("quoteMessage", [id, curve, quoteExpiry]);
      const qsig = toHex(pqcSign(this.engine.agent.pqc.secretKey, hexToBytes(qmsg)));
      const cm = await this.serial(() => this.engine.tx("commit", [id, curve, quoteExpiry, qsig]));
      rec.commit = { ...cm, ...str(curve), mid: q.mid.toString(), marginBps: q.marginBps.toString(), skewBps: q.skewBps.toString(), volBps: q.volBps.toString() };
      this.log(`batch ${id}: curve committed in block ${cm.block}`);

      // Reveal the seed strictly after the commit block.
      this.phase = "opening";
      while (Number(await pub.getBlockNumber()) <= cm.block) await new Promise((ok) => setTimeout(ok, 600));
      const ob = await this.serial(() => this.engine.tx("open", [id, toHex(cur.seed)]));
      rec.open = { ...ob, seed: toHex(cur.seed) };

      // Open every envelope from chain logs. Standing orders are sealed to the standing key.
      this.phase = "settling";
      const logs = (await pub.getContractEvents({ address: this.settlement, abi, eventName: "Sealed", args: { batch: id }, fromBlock: BigInt(cur.createdBlock), toBlock: BigInt(ob.block) })) as any[];
      const batchKeys = sealKeysFromSeed(cur.seed);
      let orders: { o: Order; sig: Hex; standing?: boolean }[] = [];
      for (const l of logs) {
        try {
          const pt = openEnvelope({ chainId: NET.chainId, purpose: purposeOf(this.settlement, id), envelope: hexToBytes(l.args.envelope), keys: batchKeys });
          const [o, sig] = decodeAbiParameters(ORDER_T, toHex(pt)) as unknown as [Order, Hex];
          orders.push({ o, sig });
        } catch { /* a standing order (other key) or garbage: skipped here */ }
      }
      const head = BigInt(ob.block);
      this.standing = this.standing.filter((s) => s.o.expiry >= head);
      for (const s of this.standing) orders.push({ o: s.o, sig: s.sig, standing: true });
      rec.opened = orders.length;

      // Leave out what cannot fill; every drop of a batch order is recorded. Standing orders just wait.
      for (;;) {
        const qi = orders.filter((x) => x.o.buy).reduce((a, x) => a + x.o.amountIn, 0n);
        const bi = orders.filter((x) => !x.o.buy).reduce((a, x) => a + x.o.amountIn, 0n);
        const price = clearingPrice(curve, qi, bi);
        const bad = orders.findIndex((x) => (x.o.buy ? (x.o.amountIn * SCALE) / price : (x.o.amountIn * price) / SCALE) < x.o.minOut || x.o.expiry < head);
        if (bad >= 0) {
          if (!orders[bad].standing) rec.dropped.push({ user: orders[bad].o.user, reason: "price outside the user's limit" });
          orders.splice(bad, 1); continue;
        }
        const baseOut = orders.filter((x) => x.o.buy).reduce((a, x) => a + (x.o.amountIn * SCALE) / price, 0n);
        const net = bi > baseOut ? bi - baseOut : baseOut - bi;
        if (orders.length && net > curve.maxNet) {
          const heavyBuy = baseOut > bi;
          let k = -1;
          orders.forEach((x, i) => { if (x.o.buy === heavyBuy && (k < 0 || x.o.amountIn > orders[k].o.amountIn)) k = i; });
          if (!orders[k].standing) rec.dropped.push({ user: orders[k].o.user, reason: "batch net larger than the maker's committed size" });
          orders.splice(k, 1); continue;
        }
        break;
      }
      if (!orders.length) { rec.settled = false; this.log(`batch ${id}: nothing fillable`); return; }

      const st = await this.serial(() => this.engine.tx("settle", [id, orders.map((x) => x.o), orders.map((x) => x.sig)], 1.2));
      const ev = ((await pub.getContractEvents({ address: this.settlement, abi, eventName: "Settled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[])[0];
      const fills = (await pub.getContractEvents({ address: this.settlement, abi, eventName: "Filled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[];
      const filledHashes = new Set(fills.map((f) => f.args.orderHash.toLowerCase()));
      this.standing = this.standing.filter((s) => !filledHashes.has(s.hash.toLowerCase()));
      const poolAt = await readPool(st.block - 1).catch(() => pool);
      rec.settled = true;
      rec.settle = { ...st, price: ev.args.price.toString(), makerBase: ev.args.makerBase.toString(), makerQuote: ev.args.makerQuote.toString() };
      rec.fills = fills.map((f) => {
        const a = f.args.amountIn as bigint;
        const amm = f.args.buy ? ammOut(poolAt.quote, poolAt.base, a) : ammOut(poolAt.base, poolAt.quote, a);
        return { user: f.args.user, orderHash: f.args.orderHash, buy: f.args.buy, amountIn: a.toString(), amountOut: f.args.amountOut.toString(), plainAmm: amm.toString(), standing: orders.find((x) => x.standing && x.o.user === f.args.user) ? true : undefined };
      });
      this.log(`batch ${id}: settled ${orders.length} in block ${st.block}`);

      this.phase = "hedging";
      rec.hedge = await this.engine.hedge(BigInt(ev.args.makerBase), this.log);
      const after = await readPool();
      this.lastMidAfter = (after.quote * SCALE) / after.base;
      rec.midAfterHedge = this.lastMidAfter.toString();
    } catch (e: any) {
      rec.error = String(e.message).slice(0, 300);
      this.log(`batch ${id} error: ${rec.error}`);
    } finally {
      rec.endedAt = new Date().toISOString();
      this.records.push(rec);
      this.save();
      this.current = null;
      this.phase = "waiting";
    }
  }

  /** Mark out settled live batches 30 blocks after settlement. Runs on a timer. */
  async markouts() {
    const head = Number(await pub.getBlockNumber());
    let changed = false;
    for (const r of this.records) {
      if (!r.settled || r.markout || r.settle.block + 30 > head) continue;
      const p = await readPool(r.settle.block + 30).catch(() => null);
      if (!p) continue;
      const later = (p.quote * SCALE) / p.base;
      const m = markout(BigInt(r.settle.makerBase), BigInt(r.settle.makerQuote), later, BigInt(r.hedge?.baseDelta ?? 0), BigInt(r.hedge?.quoteDelta ?? 0));
      r.markout = { block: r.settle.block + 30, mid: later.toString(), fill: m.fill.toString(), afterHedge: m.afterHedge.toString() };
      changed = true;
    }
    if (changed) this.save();
  }
}

function pk(k: ReturnType<typeof sealKeysFromSeed>) {
  const r = recipientOf(k) as any;
  return { mlkem: toHex(r.mlkemPublicKey), x25519: toHex(r.x25519PublicKey) };
}
function ammOut(rIn: bigint, rOut: bigint, a: bigint) {
  if ((a * 10_000n) / (rIn + a) > 500n) return 0n; // x/amm refuses over 5% impact
  const inAfter = (a * 9_970n) / 10_000n;
  return (rOut * inAfter) / (rIn + inAfter);
}
const str = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
export type { UnifiedAccount };
