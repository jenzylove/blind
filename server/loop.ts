// The live batch loop behind the web app (contract v5).
// A batch exists on chain only when someone trades. Users post a fingerprint of their order
// (keccak256(order, signature hash, salt)); the order itself stays in their browser. After
// INTAKE_MS the market maker commits its curve from its own leashed account; strictly after the
// commit block each browser reveals its own order (this server only relays it, after the commit is
// on chain), and the batch settles in one transaction and is hedged on x/amm.
// Limit orders are the exception: they wait across batches while their owner is offline, so they are
// sealed (QoreSeal, ML-KEM-1024) to this operator's standing key and revealed by the operator.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { decodeAbiParameters, toHex, hexToBytes, type Hex } from "viem";
import { pqcSign, type UnifiedAccount } from "@qorechain/sdk";
import { mldsa87 } from "@qorechain/pqc";
import { evmWindowStatus } from "@qorechain/evm";
import { open as openEnvelope, sealKeysFromSeed, recipientOf } from "@qorechain/qoreseal";
import { pub, send, windowMsg, NET, artifact, state } from "../src/chain.ts";
import { Engine, readPool, makerInventory, ORDER_T, type Order } from "../src/engine/batch.ts";
import { makeQuote, fitToMandate, clearingPrice, markout, SCALE, type Curve } from "../src/agent/policy.ts";

const { abi } = artifact("BlindSettlement");
const INTAKE_MS = Number(process.env.INTAKE_MS ?? 20_000);
const DATA = process.env.DATA_DIR ?? "data";
const DEP = state.read() as any;
export const VERSION: number = DEP.version ?? 2;
export const REVEAL_BLOCKS: number = DEP.revealBlocks ?? 20;
const STORE = VERSION >= 3 ? `${DATA}/batches-v${VERSION}.json` : `${DATA}/batches.json`;
const STANDING_STORE = VERSION >= 3 ? `${DATA}/standing-v${VERSION}.json` : `${DATA}/standing.json`;
const MAX_ORDERS = 32;
const MAX_STANDING = 40;
export const STANDING_PURPOSE = (settlement: string) => `blind-standing-v1:${settlement.toLowerCase()}`;

export type Phase = "waiting" | "intake" | "quoting" | "revealing" | "settling" | "hedging";

interface Standing { o: Order; sig: Hex; hash: string }
interface Revealed { index: number; o: Order; sig: Hex; standing?: boolean }

export class BatchLoop {
  phase: Phase = "waiting";
  current: { id: number; openBlock: number; closesAt: number; posts: any[]; commitBlock?: number; reveals: any[] } | null = null;
  standing: Standing[] = [];
  records: any[] = [];
  history: any[] = []; // unattended test runs before the app went live (test trader accounts), v2
  earlier: any[] = []; // live app batches on earlier contract versions (read only)
  private queue: Promise<unknown> = Promise.resolve();
  private extMoves: bigint[] = [];
  private lastMidAfter: bigint | null = null;
  private lastMidAt = 0; // ms; a pool move across a long idle gap is not batch volatility
  private standingSeed: Uint8Array;
  log: (s: string) => void = (s) => console.log(`[loop] ${s}`);

  constructor(public engine: Engine, standingSeedHex: string) {
    mkdirSync(DATA, { recursive: true });
    if (existsSync(STORE)) this.records = JSON.parse(readFileSync(STORE, "utf8"));
    const v2 = DEP.v2?.settlement;
    if (existsSync("deployments/batches-curve.json")) this.history = JSON.parse(readFileSync("deployments/batches-curve.json", "utf8")).filter((r: any) => r.settled).map((r: any) => ({ ...r, version: 2, contract: v2 }));
    // Earlier versions' live batches: the volume's files if this host ran them, else the snapshots in the repo.
    const earlier: any[] = [];
    const v2src = existsSync(`${DATA}/batches.json`) ? `${DATA}/batches.json` : "deployments/batches-v2-live.json";
    if (existsSync(v2src)) earlier.push(...JSON.parse(readFileSync(v2src, "utf8")).map((r: any) => ({ ...r, version: 2, contract: v2 })));
    const v3src = existsSync(`${DATA}/batches-v3.json`) ? `${DATA}/batches-v3.json` : "deployments/batches-v3-live.json";
    if (VERSION >= 4 && existsSync(v3src)) earlier.push(...JSON.parse(readFileSync(v3src, "utf8")).map((r: any) => ({ ...r, version: 3, contract: DEP.v3?.settlement })));
    const v4src = existsSync(`${DATA}/batches-v4.json`) ? `${DATA}/batches-v4.json` : "deployments/batches-v4-live.json";
    if (VERSION >= 5 && existsSync(v4src)) earlier.push(...JSON.parse(readFileSync(v4src, "utf8")).map((r: any) => ({ ...r, version: 4, contract: DEP.v4?.settlement })));
    this.earlier = earlier;
    this.standingSeed = hexToBytes(standingSeedHex as Hex);
    if (this.standingSeed.length !== 32) throw new Error("STANDING_SEED must be 32 bytes hex");
    if (existsSync(STANDING_STORE)) {
      this.standing = JSON.parse(readFileSync(STANDING_STORE, "utf8")).map((x: any) => ({ ...x,
        o: { ...x.o, batch: BigInt(x.o.batch), expiry: BigInt(x.o.expiry), amountIn: BigInt(x.o.amountIn), minOut: BigInt(x.o.minOut), nonce: BigInt(x.o.nonce) } }));
    }
  }

  private saveStanding() {
    writeFileSync(STANDING_STORE, JSON.stringify(this.standing, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  get settlement() { return this.engine.settlement; }
  standingPublicKey() { return pk(sealKeysFromSeed(this.standingSeed)); }

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
    if (w.found && (w as any).live !== false && remainingTxs > 20 && remainingBlocks > 120) return;
    await send(this.engine.settler, "hybrid", [windowMsg(this.engine.settler, {
      blocks: 3000n, maxTxs: 400n, maxValueUqor: 400n * 160_000n, allowedTargets: [this.settlement],
    })], "settler window: 400 txs / 3000 blocks, target = BlindSettlement only");
    await new Promise((ok) => setTimeout(ok, 3000));
  }

  /** Open a batch if none is open (inside the queue). */
  private async ensureBatch() {
    if (this.current) return;
    await this.ensureWindow();
    const c = await this.engine.tx("open", []);
    const id = Number(await this.engine.read<bigint>("batchCount", []));
    this.current = { id, openBlock: c.block, closesAt: Date.now() + INTAKE_MS, posts: [], reveals: [], ...({ open: c } as any) };
    this.phase = "intake";
    this.log(`batch ${id} opened (block ${c.block}); intake closes in ${INTAKE_MS / 1000}s`);
    setTimeout(() => this.close().catch((e) => this.log(`batch ${id} failed: ${e.message}`)), INTAKE_MS);
  }

  private async postFingerprint(fp: Hex) {
    const id = BigInt(this.current!.id);
    const p = await this.engine.tx("post", [id, fp]);
    const b = (await this.engine.read<any[]>("batches", [id])) as any[];
    const index = Number(b[4]) - 1; // posted count after this post (one queue: nothing in between)
    const rec = { ...p, index, fingerprint: fp };
    this.current!.posts.push(rec);
    return rec;
  }

  /** A user's order fingerprint for the current (or next) batch. Accepted on arrival: close() queues the
   *  commit behind every post that arrived while intake was open. */
  async submit(fp: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fp) || /^0x0+$/.test(fp)) throw new Error("fingerprint: 32 bytes as 0x hex");
    if (this.phase !== "waiting" && this.phase !== "intake") throw new Error("intake closed; post to the next batch");
    return this.serial(async () => {
      await this.ensureBatch();
      const r = await this.postFingerprint(fp);
      return { batch: this.current!.id, index: r.index, hash: r.hash, block: r.block, closesAt: this.current!.closesAt, revealBlocks: REVEAL_BLOCKS };
    });
  }

  /** The user's browser hands over its order only after the commit is on chain; this server relays it. */
  async submitReveal(r: { batch: number; index: number; order: Order; sig: Hex; salt: Hex }) {
    const id = BigInt(r.batch);
    const b = (await this.engine.read<any[]>("batches", [id])) as any[];
    const commitBlock = Number(b[1]);
    if (!commitBlock) throw new Error("the price is not locked yet; reveal after the commit");
    const head = Number(await pub.getBlockNumber());
    if (head > commitBlock + REVEAL_BLOCKS) throw new Error("the reveal window for this batch is over");
    const posted = await this.engine.read<Hex>("fingerprint", [id, BigInt(r.index)]);
    const fp = await this.engine.read<Hex>("fingerprintOf", [r.order, r.sig, r.salt]);
    if (posted.toLowerCase() !== fp.toLowerCase()) throw new Error("this order does not match its fingerprint");
    if ((await this.engine.read<Hex>("revealedAs", [id, BigInt(r.index)])) !== `0x${"0".repeat(64)}`) return { already: true };
    return this.serial(async () => {
      while (Number(await pub.getBlockNumber()) <= commitBlock) await new Promise((ok) => setTimeout(ok, 500));
      const t = await this.engine.tx("reveal", [id, BigInt(r.index), r.order, r.sig, r.salt], 1.3);
      if (this.current?.id === r.batch) this.current.reveals.push({ index: r.index, ...t, by: "owner" });
      return t;
    });
  }

  /** A standing limit order, sealed to the standing key. It joins every batch until it fills or expires. */
  async submitStanding(envelope: Hex) {
    const keys = sealKeysFromSeed(this.standingSeed);
    const pt = openEnvelope({ chainId: NET.chainId, purpose: STANDING_PURPOSE(this.settlement), envelope: hexToBytes(envelope), keys });
    const [o, sig] = decodeAbiParameters(ORDER_T, toHex(pt)) as unknown as [Order, Hex];
    if (o.batch !== 0n) throw new Error("a standing order must have batch 0");
    if (o.amountIn <= 0n) throw new Error("amount must be positive");
    const head = await pub.getBlockNumber();
    if (o.expiry <= head || o.expiry > head + 50_000n) throw new Error("expiry must be within the next 50,000 blocks");
    if (this.standing.length >= MAX_STANDING) throw new Error("too many open limit orders right now; try again later");
    const hash = await this.engine.read<Hex>("orderHash", [o]);
    if (this.standing.some((s) => s.hash === hash) || (await this.engine.read<boolean>("used", [hash]))) throw new Error("this order is already in");
    const key = await this.engine.read<Hex>("keyOf", [o.user]).catch(() => null);
    if (!key) throw new Error("the order's account has no proven post quantum key on chain");
    const msg = await this.engine.read<Hex>("signedOrderBytes", [o]);
    if (!mldsa87.verify(hexToBytes(key), hexToBytes(msg), hexToBytes(sig))) throw new Error("the order's signature does not verify");
    this.standing.push({ o, sig, hash });
    this.saveStanding();
    if (this.phase !== "waiting" && this.phase !== "intake") return { orderHash: hash, joins: "the next batch" };
    const r = await this.serial(async () => { await this.ensureBatch(); return { batch: this.current!.id, closesAt: this.current!.closesAt }; });
    return { ...r, orderHash: hash };
  }

  /** Simulate settle; on a revert, name the order that causes it. Null when the batch would settle. */
  private async findBreaker(id: bigint, orders: Revealed[]): Promise<{ index: number; reason: string } | null> {
    const sim = async (os: Revealed[]) => {
      try {
        await pub.simulateContract({ account: this.engine.settler.evm as Hex, address: this.settlement, abi, functionName: "settle",
          args: [id, os.map((x) => BigInt(x.index)), os.map((x) => x.o), os.map((x) => x.sig)] });
        return null;
      } catch (e: any) {
        const d = e?.cause?.data ?? e?.data;
        return { name: (d?.errorName as string) ?? "revert", args: (d?.args ?? []) as any[] };
      }
    };
    const why: Record<string, string> = {
      BadSignature: "the order's signature does not verify", KeyNotProven: "the account has no proven post quantum key",
      TransferFailed: "not enough balance or allowance when the batch settled", BadOrder: "expired, empty or for another batch",
      MinOut: "price outside the user's limit",
    };
    const all = await sim(orders);
    if (!all) return null;
    if ((all.name === "BadOrder" || all.name === "MinOut") && all.args.length) return { index: Number(all.args[0]), reason: why[all.name] };
    for (let i = 0; i < orders.length; i++) {
      const one = await sim([orders[i]]);
      if (one && one.name !== "MinOut" && one.name !== "TooBig" && one.name !== "BadPhase") return { index: i, reason: why[one.name] ?? `settle would revert (${one.name})` };
    }
    if (all.name === "BadPhase") return null; // only the timing: wait and settle
    throw new Error(`settle would revert (${all.name}) and no single order explains it`);
  }

  private async close() {
    const cur = this.current!;
    const id = BigInt(cur.id);
    const rec: any = { batch: cur.id, version: VERSION, contract: this.settlement, live: true, startedAt: new Date(cur.closesAt - INTAKE_MS).toISOString(),
      create: (cur as any).open, posts: cur.posts, reveals: cur.reveals, dropped: [], curveVersion: 2 };
    const standingIn: { s: Standing; index: number; salt: Hex }[] = [];
    try {
      this.phase = "quoting";
      // Limit orders join this batch as fingerprints too, before the price is locked.
      const head0 = await pub.getBlockNumber();
      this.standing = this.standing.filter((s) => s.o.expiry > head0 + BigInt(REVEAL_BLOCKS) + 5n);
      for (const s of this.standing.slice(0, MAX_ORDERS)) {
        const salt = toHex(randomBytes(32));
        const fp = await this.engine.read<Hex>("fingerprintOf", [s.o, s.sig, salt]);
        const p = await this.serial(() => this.postFingerprint(fp));
        standingIn.push({ s, index: p.index, salt });
      }

      // The market maker quotes from public data only, inside the owner's mandate.
      const pool = await readPool();
      const now = (pool.quote * SCALE) / pool.base;
      if (this.lastMidAfter && Date.now() - this.lastMidAt < 30 * 60_000) this.extMoves.push(((now > this.lastMidAfter ? now - this.lastMidAfter : this.lastMidAfter - now) * 10_000n) / this.lastMidAfter);
      const ext = this.extMoves.slice(-5).reduce((a, b) => (b > a ? b : a), 0n);
      const inv = await makerInventory(this.settlement, this.engine.hedger);
      const q = makeQuote(pool, { base: inv.contract.base + inv.hedger.base, quote: inv.contract.quote + inv.hedger.quote }, ext);
      const m = (await this.engine.read<any>("mandate", [])) as any[];
      const maxNet = q.maxNet < BigInt(m[0]) ? q.maxNet : BigInt(m[0]);
      const [lastPrice, lastPriceBlock, headNow] = await Promise.all([this.engine.read<bigint>("lastPrice", []), this.engine.read<bigint>("lastPriceBlock", []), pub.getBlockNumber()]);
      const fit = fitToMandate(q, { maxSpreadBps: BigInt(m[1]), bandBps: BigInt(m[2]), lastPrice, bandApplies: lastPrice > 0n && headNow <= BigInt(lastPriceBlock) + BigInt(m[3]) });
      if (!fit) throw new Error("no curve fits inside the owner's mandate right now; no price locked");
      const curve: Curve = { ...fit, maxNet };
      if (!(await this.engine.read<boolean>("withinMandate", [curve]))) throw new Error("the market maker's curve is outside the owner's mandate; no price locked");
      const quoteExpiry = BigInt(Number(await pub.getBlockNumber()) + 300);
      const qmsg = await this.engine.read<Hex>("quoteMessage", [id, curve, quoteExpiry]);
      const qsig = toHex(pqcSign(this.engine.agent.pqc.secretKey, hexToBytes(qmsg)));
      const cm = await this.serial(() => this.engine.tx("commit", [id, curve, quoteExpiry, qsig]));
      cur.commitBlock = cm.block;
      rec.commit = { ...cm, ...str(curve), mid: q.mid.toString(), marginBps: q.marginBps.toString(), skewBps: q.skewBps.toString(), volBps: q.volBps.toString() };
      this.log(`batch ${id}: curve committed in block ${cm.block}`);

      // Reveals: browsers reveal their own orders; the operator reveals the limit orders it holds.
      this.phase = "revealing";
      for (const x of standingIn) {
        while (Number(await pub.getBlockNumber()) <= cm.block) await new Promise((ok) => setTimeout(ok, 500));
        const t = await this.serial(() => this.engine.tx("reveal", [id, BigInt(x.index), x.s.o, x.s.sig, x.salt], 1.3)).catch((e) => ({ error: String(e.message).slice(0, 120) }));
        cur.reveals.push({ index: x.index, ...t, by: "operator (limit order)" });
      }
      const until = cm.block + REVEAL_BLOCKS;
      let b: any[] = [];
      for (;;) {
        b = (await this.engine.read<any[]>("batches", [id])) as any[];
        const head = Number(await pub.getBlockNumber());
        if (Number(b[5]) >= Number(b[4])) break; // every posted order revealed
        if (head > until) break;
        await new Promise((ok) => setTimeout(ok, 1500));
      }
      await this.queue; // reveals already queued land first
      b = (await this.engine.read<any[]>("batches", [id])) as any[];
      rec.posted = Number(b[4]);
      rec.revealedCount = Number(b[5]);
      rec.unrevealed = rec.posted - rec.revealedCount;

      // Read the revealed orders from chain events.
      this.phase = "settling";
      const logs = (await pub.getContractEvents({ address: this.settlement, abi, eventName: "Revealed", args: { batch: id }, fromBlock: BigInt(cm.block), toBlock: "latest" })) as any[];
      const standingIdx = new Set(standingIn.map((x) => x.index));
      let orders: Revealed[] = logs.map((l) => ({ index: Number(l.args.index), o: l.args.order as Order, sig: l.args.signature as Hex, standing: standingIdx.has(Number(l.args.index)) || undefined }));
      rec.opened = orders.length;
      // The contract lets the batch settle only once every order is revealed or the window is over.
      if (rec.unrevealed > 0) while (Number(await pub.getBlockNumber()) <= until) await new Promise((ok) => setTimeout(ok, 700));
      const head = BigInt(await pub.getBlockNumber());

      const seen = new Set<string>();
      const unique: Revealed[] = [];
      for (const x of orders) {
        const h = (await this.engine.read<Hex>("orderHash", [x.o])).toLowerCase();
        if (seen.has(h)) { rec.dropped.push({ user: x.o.user, reason: "a copy of an order already in this batch", standing: x.standing }); continue; }
        if (await this.engine.read<boolean>("used", [h])) { rec.dropped.push({ user: x.o.user, reason: "this order was already filled", standing: x.standing }); continue; }
        seen.add(h); unique.push(x);
      }
      orders = unique;
      while (orders.length > MAX_ORDERS) { const x = orders.pop()!; rec.dropped.push({ user: x.o.user, reason: "more than 32 orders in one batch", standing: x.standing }); }

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
        if (orders.length) {
          const brk = await this.findBreaker(id, orders);
          if (brk) {
            const x = orders[brk.index];
            rec.dropped.push({ user: x.o.user, reason: brk.reason, standing: x.standing });
            if (x.standing) { this.standing = this.standing.filter((s) => s.o !== x.o); this.saveStanding(); }
            orders.splice(brk.index, 1); continue;
          }
        }
        break;
      }
      if (!orders.length) { rec.settled = false; this.log(`batch ${id}: nothing fillable`); return; }

      const st = await this.serial(() => this.engine.tx("settle", [id, orders.map((x) => BigInt(x.index)), orders.map((x) => x.o), orders.map((x) => x.sig)], 1.2));
      const ev = ((await pub.getContractEvents({ address: this.settlement, abi, eventName: "Settled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[])[0];
      const fills = (await pub.getContractEvents({ address: this.settlement, abi, eventName: "Filled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[];
      const filledHashes = new Set(fills.map((f) => f.args.orderHash.toLowerCase()));
      this.standing = this.standing.filter((s) => !filledHashes.has(s.hash.toLowerCase()));
      this.saveStanding();
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
      this.lastMidAt = Date.now();
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
