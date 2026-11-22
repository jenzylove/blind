// Stress test against the live server: one crowded batch with good orders from both sides and bad
// orders mixed in. The batch must still settle for the good ones and record why each bad one was left out.
//   BLIND_ENV=<path> npx tsx scripts/stress.ts setup 10     make, fund and onboard 10 test traders (saved to STRESS_FILE)
//   BLIND_ENV=<path> npx tsx scripts/stress.ts run          send one crowded batch to SITE
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, hexToBytes, maxUint256, parseUnits, toHex, type Hex } from "viem";
import { generateMnemonic, deriveUnifiedAccount, pqcSign } from "@qorechain/sdk";
import { seal } from "@qorechain/qoreseal";
import { account, send, NET, denom, CONVERT_COIN, ensureRegistered, windowMsg, evmWallet, pub, TOKENS, ERC20_ABI, artifact, state, sleep } from "../src/chain.ts";
import { ORDER_T, FEES, type Order } from "../src/engine/batch.ts";

const SITE = process.env.SITE ?? "https://blind.jdollar.site";
const FILE = process.env.STRESS_FILE ?? "C:/Users/LENOVO/blind-launch/stress-traders.json";
const { abi } = artifact("BlindSettlement");
const { settlement } = state.read() as { settlement: Hex };
const SCALE = 10n ** 18n;
const traderOf = async (m: string) => deriveUnifiedAccount(m, 0) as any;

async function setup(n: number) {
  const op = await account("OPERATOR");
  const words = Array.from({ length: n + 1 }, () => generateMnemonic());
  const accs = await Promise.all(words.map(traderOf));
  // Last one is "broke": registered and approved, but no tokens.
  writeFileSync(FILE, JSON.stringify(words));
  for (let i = 0; i < accs.length; i++) {
    const a = accs[i];
    const msgs: any[] = [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: a.cosmos, amount: [{ denom: "uqor", amount: "400000" }] } }];
    if (i < n) {
      msgs.push({ typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fUSD"), amount: parseUnits("8", 6).toString() }, receiver: a.evm, sender: op.cosmos } });
      msgs.push({ typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fETH"), amount: parseUnits("0.0025", 18).toString() }, receiver: a.evm, sender: op.cosmos } });
    }
    await send(op, "hybrid", msgs, `stress: fund trader ${i}${i === n ? " (broke: QOR only)" : ""}`, "1400000");
  }
  for (const a of accs) {
    await ensureRegistered(a);
    await send(a, "hybrid", [windowMsg(a, { blocks: 600n, maxTxs: 2n, maxValueUqor: 60_000n, allowedTargets: [TOKENS.fUSD.address, TOKENS.fETH.address] })], `window ${a.cosmos.slice(0, 10)}`);
    await sleep(3000);
    for (const t of [TOKENS.fUSD.address, TOKENS.fETH.address]) {
      const h = await evmWallet(a).writeContract({ address: t, abi: ERC20_ABI, functionName: "approve", args: [settlement, maxUint256], gas: 80_000n, ...FEES } as any);
      await pub.waitForTransactionReceipt({ hash: h });
    }
  }
  writeFileSync(FILE, JSON.stringify(words));
  console.log(`saved ${words.length} traders to ${FILE}`);
}

async function sealed(a: any, s: any, o: Order, batchKey: { mlkem: string; x25519: string }, purpose: string, sigOverride?: Hex) {
  const msg = (await pub.readContract({ address: settlement, abi, functionName: "signedOrderBytes", args: [o] })) as Hex;
  const sig = sigOverride ?? toHex(pqcSign(a.pqc.secretKey, hexToBytes(msg)));
  const env = seal({ chainId: NET.chainId, purpose, recipients: [{ mlkemPublicKey: hexToBytes(batchKey.mlkem as Hex), x25519PublicKey: hexToBytes(batchKey.x25519 as Hex) }],
    plaintext: hexToBytes(encodeAbiParameters(ORDER_T, [o, sig])) });
  return toHex(env);
}
const post = async (path: string, envelope: Hex) => {
  const r = await fetch(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

async function run() {
  const words: string[] = JSON.parse(readFileSync(FILE, "utf8"));
  const accs = await Promise.all(words.map(traderOf));
  const broke = accs.pop();
  const s = (await (await fetch(`${SITE}/api/state`)).json()) as any;
  if (!s.batch.taking) throw new Error("a batch is not taking orders right now; retry in a minute");
  const id = BigInt(s.batch.id), mid = BigInt(s.pool.mid), head = await pub.getBlockNumber();
  const key = s.batch.publicKey, purpose = `blind-order-v1:${settlement.toLowerCase()}:${id}`;
  const order = (a: any, buy: boolean, amountIn: bigint, nonce: bigint, batch = id): Order => ({ user: a.evm, batch, expiry: head + 400n, buy, amountIn, nonce,
    minOut: buy ? (amountIn * SCALE * 10_000n) / (mid * 10_400n) : (amountIn * mid * 9_600n) / (SCALE * 10_000n) });
  const plan: { label: string; env: Hex; path?: string }[] = [];
  for (let i = 0; i < accs.length; i++) {
    const buy = i % 2 === 0;
    plan.push({ label: `${buy ? "buy" : "sell"} #${i}`, env: await sealed(accs[i], s, order(accs[i], buy, buy ? parseUnits("4", 6) : parseUnits("0.0012", 18), BigInt(Date.now() + i)), key, purpose) });
  }
  plan.push({ label: "copy of buy #0 (same envelope again)", env: plan[0].env });
  plan.push({ label: "broke account: no tokens", env: await sealed(broke, s, order(broke, true, parseUnits("3", 6), 7n), key, purpose) });
  plan.push({ label: "sealed to this batch but says batch id + 5", env: await sealed(accs[1], s, order(accs[1], false, parseUnits("0.001", 18), 99n, id + 5n), key, purpose) });
  // A limit order with a forged signature, sealed to the standing key: must be refused on arrival.
  const forged = toHex(new Uint8Array(4627).fill(7));
  const standingPurpose = `blind-standing-v1:${settlement.toLowerCase()}`;
  const lim = await sealed(accs[2], s, { ...order(accs[2], true, parseUnits("2", 6), 55n, 0n), expiry: head + 2000n }, s.standingKey, standingPurpose, forged);
  const t0 = Date.now();
  const results = await Promise.all(plan.map(async (p) => ({ label: p.label, ...(await post("/api/order", p.env)) })));
  const limR = await post("/api/limit", lim);
  for (const r of results) console.log(`${r.status} ${r.label}${r.status !== 200 ? " -> " + r.body.error : ""}`);
  console.log(`${limR.status} forged limit order -> ${limR.body.error ?? "accepted (BAD)"}`);
  console.log(`posted in ${Date.now() - t0} ms; waiting for batch ${id} to settle`);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const b = (await (await fetch(`${SITE}/api/batch/${id}?v=3`)).json().catch(() => null)) as any;
    if (b && b.batch && (b.settled !== undefined || b.error)) {
      console.log(`batch ${id}: settled ${b.settled}, opened ${b.opened}, fills ${b.fills?.length ?? 0}, price ${b.settle?.price}${b.error ? ", error " + b.error : ""}`);
      for (const d of b.dropped ?? []) console.log(`  left out: ${d.user.slice(0, 10)} ${d.reason}`);
      for (const f of b.fills ?? []) console.log(`  fill ${f.buy ? "buy " : "sell"} ${f.user.slice(0, 10)} out ${f.amountOut} vs x/amm ${f.plainAmm} (${((Number(f.amountOut) / Number(f.plainAmm) - 1) * 100).toFixed(2)}%)`);
      return;
    }
  }
  console.log("batch did not finish in 5 minutes");
}

/** After a contract upgrade: open a window and approve the current contract for every saved trader. */
async function reapprove() {
  const accs = await Promise.all((JSON.parse(readFileSync(FILE, "utf8")) as string[]).map(traderOf));
  for (const a of accs) {
    await send(a, "hybrid", [windowMsg(a, { blocks: 600n, maxTxs: 2n, maxValueUqor: 60_000n, allowedTargets: [TOKENS.fUSD.address, TOKENS.fETH.address] })], `window ${a.cosmos.slice(0, 10)}`);
    await sleep(3000);
    for (const t of [TOKENS.fUSD.address, TOKENS.fETH.address]) {
      const h = await evmWallet(a).writeContract({ address: t, abi: ERC20_ABI, functionName: "approve", args: [settlement, maxUint256], gas: 80_000n, ...FEES } as any);
      await pub.waitForTransactionReceipt({ hash: h });
    }
  }
  console.log(`approved ${settlement} for ${accs.length} traders`);
}

if (process.argv[2] === "setup") await setup(Number(process.argv[3] ?? 10));
else if (process.argv[2] === "reapprove") await reapprove();
else await run();
