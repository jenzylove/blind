// One Blind batch, end to end, against the live testnet.
// Order of events is the product's promise: orders sealed and posted -> agent commits a quote
// from public pool data only -> batch seed revealed in a later block -> orders opened from
// chain logs -> one settle() -> hedge on x/amm from a separate account.
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, decodeAbiParameters, keccak256, toHex, hexToBytes, encodeFunctionData, type Hex } from "viem";
import { pqcSign, buildPhantomExecuteEvm, fetchAuthNonce, resolveEvmAuthDigestVersion, type UnifiedAccount } from "@qorechain/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";
import { seal, open as openEnvelope, sealKeysFromSeed, recipientOf } from "@qorechain/qoreseal";
import { evmWallet, pub, send, sleep, broadcast, waitTx, artifact, TOKENS, denom, ERC20_ABI, NET, balances } from "../chain.ts";
import { makeQuote, clearingPrice, cpIn, SCALE, type Pool, type Quote } from "../agent/policy.ts";

export const POOL_ID = "3";
const { abi } = artifact("BlindSettlement");
export const FEES = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
export const ORDER_T = [{ type: "tuple", components: [
  { name: "user", type: "address" }, { name: "batch", type: "uint64" }, { name: "expiry", type: "uint64" },
  { name: "buy", type: "bool" }, { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "nonce", type: "uint256" },
] }, { type: "bytes" }] as const;

export interface Order { user: Hex; batch: bigint; expiry: bigint; buy: boolean; amountIn: bigint; minOut: bigint; nonce: bigint }
export interface Intent { acc: UnifiedAccount; buy: boolean; amountIn: bigint; limitBps: bigint } // limit vs pool mid

export async function readPool(height?: number): Promise<Pool> {
  const r = await fetch(`${NET.rest}/qorechain/amm/v1/pools/${POOL_ID}`, height ? { headers: { "x-cosmos-block-height": String(height) } } : {});
  if (!r.ok) throw new Error(`pool read HTTP ${r.status}`);
  const p = ((await r.json()) as any).pool;
  const baseIsA = p.token_a === denom("fETH");
  return { base: BigInt(baseIsA ? p.reserve_a : p.reserve_b), quote: BigInt(baseIsA ? p.reserve_b : p.reserve_a), feeBps: 30n, maxImpactBps: 500n };
}

export async function makerInventory(settlement: Hex, hedger: UnifiedAccount) {
  const [cb, cq, hb] = await Promise.all([
    pub.readContract({ address: TOKENS.fETH.address, abi: ERC20_ABI, functionName: "balanceOf", args: [settlement] }),
    pub.readContract({ address: TOKENS.fUSD.address, abi: ERC20_ABI, functionName: "balanceOf", args: [settlement] }),
    balances(hedger.cosmos),
  ]);
  return {
    contract: { base: cb as bigint, quote: cq as bigint },
    hedger: { base: BigInt(hb[denom("fETH")] ?? 0), quote: BigInt(hb[denom("fUSD")] ?? 0) },
  };
}

/** The agent's ed25519 key, linked on chain to the settler account with spending rules. */
export interface AgentLink { sk: Uint8Array; pk: Uint8Array }
export const agentLinkFrom = (hexSeed?: string): AgentLink | undefined => {
  if (!hexSeed) return undefined;
  const sk = hexToBytes((hexSeed.startsWith("0x") ? hexSeed : `0x${hexSeed}`) as Hex);
  return { sk, pk: ed25519.getPublicKey(sk) };
};

export class Engine {
  constructor(public settlement: Hex, public settler: UnifiedAccount, public agent: UnifiedAccount, public hedger: UnifiedAccount, public link?: AgentLink) {}

  async tx(functionName: string, args: any[], margin = 1.25) {
    const data = encodeFunctionData({ abi, functionName, args });
    const est = await pub.estimateGas({ account: this.settler.evm as Hex, to: this.settlement, data });
    if (this.link) return this.agentTx(functionName, data, Math.ceil(Number(est) * margin));
    const hash = await evmWallet(this.settler).sendTransaction({ to: this.settlement, data, gas: BigInt(Math.ceil(Number(est) * margin)), ...FEES });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return { hash, block: Number(rc.blockNumber), gas: Number(rc.gasUsed) };
  }

  /** The agent's call, made with its linked key under the account's on-chain spending rule
   *  (only BlindSettlement's batch functions). The settler only relays and pays the fee. */
  private async agentTx(functionName: string, data: Hex, gasLimit: number) {
    const link = this.link!;
    const { nonce } = await fetchAuthNonce({ rest: NET.rest, address: this.settler.cosmos, pubkey: link.pk });
    const digestVersion = await resolveEvmAuthDigestVersion({ rest: NET.rest } as any).catch(() => "v2");
    const msg = await buildPhantomExecuteEvm({
      wallet: { publicKey: link.pk, signMessage: async (m: Uint8Array) => ed25519.sign(m, link.sk) },
      relayer: this.settler.cosmos, chainId: NET.chainId, account: this.settler.cosmos,
      to: this.settlement, value: "0", data: hexToBytes(data), gasLimit, nonce, digestVersion: digestVersion as any,
    });
    const cosmosHash = await broadcast(this.settler, "hybrid", [msg], String(gasLimit + 250_000));
    const r = await waitTx(cosmosHash);
    if (r.code) throw new Error(`${functionName} refused: ${String(r.log).slice(0, 200)} (${cosmosHash})`);
    const ev = (t: string) => r.events.filter((e: any) => e.type === t);
    const failed = ev("abstractaccount_execution_failed")[0];
    if (failed) throw new Error(`${functionName} failed: ${failed.attributes.find((a: any) => a.key === "reason")?.value} (${cosmosHash})`);
    const evmHash = ev("ethereum_tx").flatMap((e: any) => e.attributes).find((a: any) => a.key === "ethereumTxHash")?.value as Hex | undefined;
    let gas = 0;
    if (evmHash) {
      const rc = await pub.waitForTransactionReceipt({ hash: evmHash });
      if (rc.status !== "success") throw new Error(`${functionName} reverted: ${evmHash}`);
      gas = Number(rc.gasUsed);
    }
    return { hash: (evmHash ?? cosmosHash) as Hex, cosmosHash, block: r.height, gas, via: "agent key" as const };
  }

  read<T>(functionName: string, args: any[]) {
    return pub.readContract({ address: this.settlement, abi, functionName, args }) as Promise<T>;
  }

  /** Run one batch. `intents` are the users' orders, signed and sealed before the agent quotes. */
  async run(intents: Intent[], extMoveBps: bigint, log: (s: string) => void = console.log) {
    const rec: any = { startedAt: new Date().toISOString(), dropped: [] as any[] };

    // 1. Create. The seed's hash is fixed on chain; the ML-KEM key pair is derived from the seed.
    const seed = new Uint8Array(randomBytes(32));
    const keys = sealKeysFromSeed(seed);
    const c = await this.tx("create", [keccak256(seed)]);
    const id = await this.read<bigint>("batchCount", []);
    rec.batch = Number(id); rec.create = c;
    const purpose = `blind-order-v1:${this.settlement.toLowerCase()}:${id}`;
    log(`batch ${id}: created in block ${c.block}`);

    // 2. Users sign and seal; the relayer posts. The pool mid only sets each user's own limit.
    const pool0 = await readPool();
    const mid0 = (pool0.quote * SCALE) / pool0.base;
    const head = Number(await pub.getBlockNumber());
    rec.posts = [];
    for (const it of intents) {
      const o: Order = {
        user: it.acc.evm as Hex, batch: id, expiry: BigInt(head + 400), buy: it.buy, amountIn: it.amountIn, nonce: BigInt(Date.now()),
        minOut: it.buy ? (it.amountIn * SCALE * 10_000n) / (mid0 * (10_000n + it.limitBps)) : (it.amountIn * mid0 * (10_000n - it.limitBps)) / (SCALE * 10_000n),
      };
      const msg = await this.read<Hex>("orderMessage", [o]);
      const sig = toHex(pqcSign(it.acc.pqc.secretKey, hexToBytes(msg)));
      const env = seal({ chainId: NET.chainId, purpose, recipients: [recipientOf(keys)], plaintext: hexToBytes(encodeAbiParameters(ORDER_T, [o, sig])) });
      const p = await this.tx("post", [id, toHex(env)]);
      rec.posts.push({ ...p, bytes: env.length });
    }
    log(`batch ${id}: ${intents.length} sealed orders posted`);

    // 3. The agent quotes from public data only: pool reserves, its inventory, recent mids.
    const pool = await readPool();
    const inv = await makerInventory(this.settlement, this.hedger);
    const q: Quote = makeQuote(pool, { base: inv.contract.base + inv.hedger.base, quote: inv.contract.quote + inv.hedger.quote }, extMoveBps);
    const curve = { bid: q.bid, ask: q.ask, bidMax: q.bidMax, askMax: q.askMax, maxNet: q.maxNet };
    const quoteExpiry = BigInt(Number(await pub.getBlockNumber()) + 300);
    const qmsg = await this.read<Hex>("quoteMessage", [id, curve, quoteExpiry]);
    const qsig = toHex(pqcSign(this.agent.pqc.secretKey, hexToBytes(qmsg)));
    const cm = await this.tx("commit", [id, curve, quoteExpiry, qsig]);
    rec.commit = { ...cm, ...strs(q), quoteExpiry: Number(quoteExpiry), inventory: strs({ cBase: inv.contract.base, cQuote: inv.contract.quote, hBase: inv.hedger.base, hQuote: inv.hedger.quote }) };
    log(`batch ${id}: curve committed in block ${cm.block}: bid ${fmt(q.bid)}..${fmt(q.bidMax)} ask ${fmt(q.ask)}..${fmt(q.askMax)} (mid ${fmt(q.mid)}) max ${Number(q.maxNet) / 1e18} fETH`);

    // 4. Reveal the seed strictly after the commit block.
    while (Number(await pub.getBlockNumber()) <= cm.block) await sleep(600);
    const ob = await this.tx("open", [id, toHex(seed)]);
    rec.open = ob;

    // 5. Open every envelope from chain logs with the revealed seed.
    const logs = (await pub.getContractEvents({ address: this.settlement, abi, eventName: "Sealed", args: { batch: id }, fromBlock: BigInt(c.block), toBlock: BigInt(ob.block) })) as any[];
    let orders = logs.map((l) => {
      const [o, sig] = decodeAbiParameters(ORDER_T, toHex(openEnvelope({ chainId: NET.chainId, purpose, envelope: hexToBytes(l.args.envelope), keys: sealKeysFromSeed(seed) })));
      return { o: o as Order, sig: sig as Hex };
    });

    // 6. Leave out orders that cannot fill (user's limit or maker size); every drop is recorded.
    for (;;) {
      const qi = orders.filter((x) => x.o.buy).reduce((a, x) => a + x.o.amountIn, 0n);
      const bi = orders.filter((x) => !x.o.buy).reduce((a, x) => a + x.o.amountIn, 0n);
      const price = clearingPrice(curve, qi, bi);
      const bad = orders.findIndex((x) => (x.o.buy ? (x.o.amountIn * SCALE) / price : (x.o.amountIn * price) / SCALE) < x.o.minOut);
      if (bad >= 0) { rec.dropped.push({ user: orders[bad].o.user, reason: "price outside the user's limit" }); orders.splice(bad, 1); continue; }
      const baseOut = orders.filter((x) => x.o.buy).reduce((a, x) => a + (x.o.amountIn * SCALE) / price, 0n);
      const quoteOut = orders.filter((x) => !x.o.buy).reduce((a, x) => a + (x.o.amountIn * price) / SCALE, 0n);
      const net = bi > baseOut ? bi - baseOut : baseOut - bi;
      void quoteOut;
      if (orders.length && net > q.maxNet) {
        // drop the largest order on the heavy side
        const heavyBuy = baseOut > bi;
        let k = -1;
        orders.forEach((x, i) => { if (x.o.buy === heavyBuy && (k < 0 || x.o.amountIn > orders[k].o.amountIn)) k = i; });
        rec.dropped.push({ user: orders[k].o.user, reason: "batch net larger than the maker's committed size" });
        orders.splice(k, 1);
        continue;
      }
      break;
    }
    if (!orders.length) { log(`batch ${id}: nothing fillable, not settled`); rec.settled = false; return rec; }

    // 7. Settle: one transaction, every check on chain.
    const st = await this.tx("settle", [id, orders.map((x) => x.o), orders.map((x) => x.sig)], 1.2);
    const ev = ((await pub.getContractEvents({ address: this.settlement, abi, eventName: "Settled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[])[0];
    const fills = (await pub.getContractEvents({ address: this.settlement, abi, eventName: "Filled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[];
    rec.settled = true;
    rec.settle = { ...st, price: ev.args.price.toString(), makerBase: ev.args.makerBase.toString(), makerQuote: ev.args.makerQuote.toString() };
    rec.fills = fills.map((f) => ({ user: f.args.user, buy: f.args.buy, amountIn: f.args.amountIn.toString(), amountOut: f.args.amountOut.toString() }));
    // What x/amm would have paid each user for the same input at the settle block (read at that height).
    const poolAt = await readPool(st.block - 1).catch(() => pool);
    rec.fills.forEach((f: any) => {
      const a = BigInt(f.amountIn);
      f.plainAmm = (f.buy ? cpOutSafe(poolAt.quote, poolAt.base, a) : cpOutSafe(poolAt.base, poolAt.quote, a)).toString();
    });
    log(`batch ${id}: settled ${orders.length} orders in block ${st.block} at ${fmt(ev.args.price)}; maker ${Number(ev.args.makerBase) / 1e18} fETH, ${Number(ev.args.makerQuote) / 1e6} fUSD`);

    // 8. Hedge the maker's net on x/amm from the separate hedging account.
    rec.hedge = await this.hedge(BigInt(ev.args.makerBase), log);
    const after = await readPool();
    rec.midAfterHedge = ((after.quote * SCALE) / after.base).toString();
    return rec;
  }

  async hedge(makerBase: bigint, log: (s: string) => void) {
    const DUST = 100_000_000_000_000n; // 0.0001 fETH
    const abs = makerBase < 0n ? -makerBase : makerBase;
    if (abs < DUST) return { skipped: "net below 0.0001 fETH" };
    const pool = await readPool();
    const before = await balances(this.hedger.cosmos);
    // Maker sold base -> hedger buys it back with fUSD. Maker bought base -> hedger sells it.
    const buyBase = makerBase < 0n;
    const tokenIn = buyBase ? { denom: denom("fUSD"), amount: cpIn(pool.quote, pool.base, abs, 30n).toString() } : { denom: denom("fETH"), amount: abs.toString() };
    const expected = buyBase ? abs : cpOutSafe(pool.base, pool.quote, abs);
    try {
      const r = await send(this.hedger, "hybrid", [{ typeUrl: "/qorechain.amm.v1.MsgSwapExactIn", value: {
        sender: this.hedger.cosmos, poolId: POOL_ID, tokenIn, denomOut: buyBase ? denom("fETH") : denom("fUSD"), minOut: ((expected * 98n) / 100n).toString(),
      } }], `hedge: ${buyBase ? "buy" : "sell"} ${Number(abs) / 1e18} fETH on x/amm`);
      const after = await balances(this.hedger.cosmos);
      const d = (k: string) => (BigInt(after[k] ?? 0) - BigInt(before[k] ?? 0)).toString();
      return { hash: r.hash, height: r.height, baseDelta: d(denom("fETH")), quoteDelta: d(denom("fUSD")) };
    } catch (e: any) {
      log(`hedge failed: ${String(e.message).slice(0, 160)}`);
      return { failed: String(e.message).slice(0, 300) };
    }
  }
}

function cpOutSafe(rIn: bigint, rOut: bigint, a: bigint) {
  // x/amm refuses swaps over 5% impact; report 0 ("refused") in that case.
  if ((a * 10_000n) / (rIn + a) > 500n) return 0n;
  const inAfter = (a * 9_970n) / 10_000n;
  return (rOut * inAfter) / (rIn + inAfter);
}
const fmt = (p: bigint) => (Number(p) / 1e6).toFixed(2);
const strs = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
