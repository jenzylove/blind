// Phase 3 check: N batches run unattended on testnet, then a markout table.
// Order flow comes from two test-trader accounts we own (USER1 buys, USER2 sells, at random).
//   BLIND_ENV=<path> npx tsx scripts/run-batches.ts fund
//   BLIND_ENV=<path> npx tsx scripts/run-batches.ts run 10
//   BLIND_ENV=<path> npx tsx scripts/run-batches.ts markout
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseUnits, type Hex } from "viem";
import { account, send, windowMsg, closeWindow, sleep, state, denom, CONVERT_COIN, pub } from "../src/chain.ts";
import { Engine, readPool, type Intent } from "../src/engine/batch.ts";
import { markout, SCALE } from "../src/agent/policy.ts";

const OUT = process.env.BATCHES ?? "deployments/batches-curve.json"; // v1 band runs: deployments/batches.json
const load = (): any[] => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : []);
const save = (rows: any[]) => writeFileSync(OUT, JSON.stringify(rows, null, 2) + "\n");

const [op, agent, hedger, u1, u2] = await Promise.all(["OPERATOR", "AGENT", "HEDGER", "USER1", "USER2"].map((r) => account(r as any)));
const { settlement } = state.read() as { settlement: Hex };

async function fund() {
  // Hedger: some fETH bank coin so it can sell when the maker buys. USER2: more fETH to sell.
  await send(op, "hybrid", [
    { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: hedger.cosmos, amount: [{ denom: denom("fETH"), amount: parseUnits("0.02", 18).toString() }] } },
    { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fETH"), amount: parseUnits("0.015", 18).toString() }, receiver: u2.evm, sender: op.cosmos } },
  ], "fund: 0.02 fETH to hedger, 0.015 fETH (ERC-20) to USER2", "900000");
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function run(n: number) {
  const rows = load();
  await send(op, "hybrid", [windowMsg(op, { blocks: 3000n, maxTxs: BigInt(n * 6 + 4), maxValueUqor: BigInt(n * 6 + 4) * 120_000n, allowedTargets: [settlement] })],
    `settler window: ${n * 6 + 4} txs, target = BlindSettlement only`);
  await sleep(4000);
  const engine = new Engine(settlement, op, agent, hedger);
  // Outside volatility: pool moves between our last hedge and the next batch (our own swaps excluded).
  const ext: bigint[] = [];
  let lastAfter: bigint | null = null;
  try {
    for (let i = 0; i < n; i++) {
      const p = await readPool();
      const now = (p.quote * SCALE) / p.base;
      if (lastAfter) ext.push(((now > lastAfter ? now - lastAfter : lastAfter - now) * 10_000n) / lastAfter);
      const extMove = ext.slice(-5).reduce((a, b) => (b > a ? b : a), 0n);
      const intents: Intent[] = [];
      if (Math.random() < 0.8) intents.push({ acc: u1, buy: true, amountIn: parseUnits(rand(1.5, 5).toFixed(6), 6), limitBps: 400n });
      if (Math.random() < 0.8) intents.push({ acc: u2, buy: false, amountIn: parseUnits(rand(0.0006, 0.0018).toFixed(8), 18), limitBps: 400n });
      if (!intents.length) intents.push({ acc: u1, buy: true, amountIn: parseUnits("2", 6), limitBps: 400n });
      try {
        const rec = await engine.run(intents, extMove);
        rec.curveVersion = 2;
        rows.push(rec);
        lastAfter = rec.midAfterHedge ? BigInt(rec.midAfterHedge) : null;
      } catch (e: any) {
        console.log(`batch attempt ${i + 1} failed: ${String(e.message).slice(0, 200)}`);
        rows.push({ failed: String(e.message).slice(0, 300), at: new Date().toISOString() });
      }
      save(rows);
    }
  } finally {
    await closeWindow(op);
  }
}

async function markoutAll() {
  const rows = load();
  const head = Number(await pub.getBlockNumber());
  for (const r of rows) {
    if (!r.settled || r.markout) continue;
    const at = r.settle.block + 30;
    if (at > head) { console.log(`batch ${r.batch}: markout block ${at} not reached yet`); continue; }
    const p = await readPool(at);
    const later = (p.quote * SCALE) / p.base;
    const hb = BigInt(r.hedge?.baseDelta ?? 0), hq = BigInt(r.hedge?.quoteDelta ?? 0);
    const m = markout(BigInt(r.settle.makerBase), BigInt(r.settle.makerQuote), later, hb, hq);
    r.markout = { block: at, mid: later.toString(), fill: m.fill.toString(), afterHedge: m.afterHedge.toString() };
  }
  save(rows);
  console.log("batch | orders | price fUSD/fETH | maker fETH | maker fUSD | markout fill | markout after hedge");
  let tf = 0, th = 0;
  for (const r of rows.filter((x) => x.settled)) {
    const f = r.markout ? Number(r.markout.fill) / 1e6 : NaN, h = r.markout ? Number(r.markout.afterHedge) / 1e6 : NaN;
    if (r.markout) { tf += f; th += h; }
    console.log(`${r.batch} | ${r.fills.length} | ${(Number(r.settle.price) / 1e6).toFixed(2)} | ${(Number(r.settle.makerBase) / 1e18).toFixed(6)} | ${(Number(r.settle.makerQuote) / 1e6).toFixed(4)} | ${f.toFixed(4)} | ${h.toFixed(4)}`);
  }
  console.log(`total markout: fill ${tf.toFixed(4)} fUSD, after hedge ${th.toFixed(4)} fUSD; failed attempts ${rows.filter((x) => x.failed).length}; unsettled ${rows.filter((x) => x.settled === false).length}`);
}

const cmd = process.argv[2];
if (cmd === "fund") await fund();
else if (cmd === "run") await run(Number(process.argv[3] ?? 10));
else if (cmd === "markout") await markoutAll();
