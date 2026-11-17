// Phase 2 check on testnet: deploy BlindSettlement, stock the maker, onboard two users,
// then run one real batch end to end: sealed orders (ML-KEM-1024) posted on chain, the
// agent's ML-DSA-87 quote committed, the batch key revealed after the commit block,
// orders opened from chain data, and one atomic settle.
//   BLIND_ENV=<path> npx tsx scripts/testnet-batch.ts deploy | stock | onboard | batch
import { randomBytes } from "node:crypto";
import {
  encodeAbiParameters, decodeAbiParameters, keccak256, toHex, hexToBytes, parseUnits, formatUnits, encodeFunctionData, type Hex,
} from "viem";
import { pqcSign } from "@qorechain/sdk";
import { seal, open as openEnvelope, sealKeysFromSeed, recipientOf } from "@qorechain/qoreseal";
import {
  account, artifact, evmWallet, pub, send, windowMsg, closeWindow, ensureRegistered, sleep, state,
  TOKENS, denom, CONVERT_COIN, ERC20_ABI, NET,
} from "./chain.ts";

const { abi, bytecode } = artifact("BlindSettlement");
const FEE_CAP = 150_000_000_000n; // 150 gwei cap; base fee on testnet is 112.5 gwei
const fees = { maxFeePerGas: FEE_CAP, maxPriorityFeePerGas: 1_000_000_000n };
const uqor = (gas: bigint) => (gas * FEE_CAP + 999_999_999_999n) / 1_000_000_000_000n;
const ORDER_T = [{ type: "tuple", components: [
  { name: "user", type: "address" }, { name: "batch", type: "uint64" }, { name: "expiry", type: "uint64" },
  { name: "buy", type: "bool" }, { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "nonce", type: "uint256" },
] }, { type: "bytes" }] as const;

const op = await account("OPERATOR");
const agent = await account("AGENT");
const hedger = await account("HEDGER");

async function window(acc: typeof op, maxTxs: bigint, gasEach: bigint, targets: string[] | undefined, label: string) {
  await send(acc, "hybrid", [windowMsg(acc, { blocks: 600n, maxTxs, maxValueUqor: uqor(gasEach) * maxTxs, allowedTargets: targets })], label);
  await sleep(4000);
}

async function deploy() {
  await window(op, 1n, 3_000_000n, undefined, "operator window: 1 tx (deploy)");
  try {
    const hash = await evmWallet(op).deployContract({
      abi, bytecode, gas: 3_000_000n, ...fees,
      args: [TOKENS.fETH.address, TOKENS.fUSD.address, agent.evm, op.evm, hedger.evm, 600n],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`BlindSettlement ${rc.contractAddress} tx ${hash} status ${rc.status}`);
    state.write({ chainId: 9800, settlement: rc.contractAddress, deployTx: hash, base: "fETH", quote: "fUSD",
      agent: agent.evm, settler: op.evm, treasury: hedger.evm, settleWindowBlocks: 600 });
  } finally { await sleep(2000); await closeWindow(op); }
}

async function stock() {
  const { settlement } = state.read();
  const r = await send(op, "hybrid", [
    { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fETH"), amount: parseUnits("0.05", 18).toString() }, receiver: settlement, sender: op.cosmos } },
    { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fUSD"), amount: parseUnits("100", 6).toString() }, receiver: settlement, sender: op.cosmos } },
  ], "stock maker inventory: 0.05 fETH + 100 fUSD into the contract", "1200000");
  state.write({ stockTx: r.hash });
}

async function onboard() {
  const { settlement } = state.read();
  // USER1 already holds fUSD (spike). USER2 is new: the relayer pays for everything.
  const u2 = await account("USER2");
  await send(op, "hybrid", [
    { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: u2.cosmos, amount: [{ denom: "uqor", amount: "500000" }] } },
    { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fETH"), amount: parseUnits("0.01", 18).toString() }, receiver: u2.evm, sender: op.cosmos } },
  ], "relayer: 0.5 QOR + 0.01 fETH (ERC-20) to USER2", "900000");
  await ensureRegistered(u2);
  for (const [role, token] of [["USER1", TOKENS.fUSD.address], ["USER2", TOKENS.fETH.address]] as const) {
    const u = await account(role);
    await window(u, 1n, 80_000n, [token], `${role} window: 1 tx, target ${token === TOKENS.fUSD.address ? "fUSD" : "fETH"} only`);
    const hash = await evmWallet(u).writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [settlement, 2n ** 256n - 1n], gas: 80_000n, ...fees });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`${role} approve ${hash} ${rc.status}`);
  }
}

async function poolMid() {
  const p = (await (await fetch(`${NET.rest}/qorechain/amm/v1/pools/3`)).json()) as any;
  const pool = p.pool ?? p;
  const eth = BigInt(pool.token_a === denom("fETH") ? pool.reserve_a : pool.reserve_b);
  const usd = BigInt(pool.token_a === denom("fUSD") ? pool.reserve_a : pool.reserve_b);
  return (usd * 10n ** 18n) / eth; // fUSD base units per fETH base unit, x 1e18
}

async function evmTx(label: string, functionName: string, args: any[], extra = 1.25) {
  const { settlement } = state.read();
  const data = encodeFunctionData({ abi, functionName, args });
  const est = await pub.estimateGas({ account: op.evm as Hex, to: settlement, data });
  const gas = BigInt(Math.ceil(Number(est) * extra));
  const hash = await evmWallet(op).sendTransaction({ to: settlement, data, gas, ...fees });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${hash} block ${rc.blockNumber} ${rc.status} (estimate ${est}, charged ${rc.gasUsed})`);
  if (rc.status !== "success") throw new Error(`${label} reverted`);
  return { hash, block: Number(rc.blockNumber), rc };
}

async function batch() {
  const { settlement } = state.read();
  const run: Record<string, any> = {};
  await window(op, 6n, 2_500_000n, [settlement], "settler window: 6 txs, target = BlindSettlement only");

  // 1. Create: fix the hash of the batch seed. The ML-KEM key pair comes from the seed.
  const seed = new Uint8Array(randomBytes(32));
  const keys = sealKeysFromSeed(seed);
  const c = await evmTx("create", "create", [keccak256(seed)]);
  const id = BigInt((await pub.readContract({ address: settlement, abi, functionName: "batchCount" })) as bigint);
  run.batch = Number(id); run.create = c.hash;

  // 2. Users sign and seal orders. The relayer posts the envelopes.
  const mid = await poolMid();
  const bid = (mid * 9970n) / 10000n, ask = (mid * 10030n) / 10000n; // the agent's committed band, 30 bps each side
  const head = Number(await pub.getBlockNumber());
  const u1 = await account("USER1"), u2 = await account("USER2");
  const orders = [
    { acc: u1, o: { user: u1.evm as Hex, batch: id, expiry: BigInt(head + 500), buy: true, amountIn: parseUnits("20", 6), minOut: (parseUnits("20", 6) * 10n ** 18n / ask) * 99n / 100n, nonce: 1n } },
    { acc: u2, o: { user: u2.evm as Hex, batch: id, expiry: BigInt(head + 500), buy: false, amountIn: parseUnits("0.004", 18), minOut: (parseUnits("0.004", 18) * bid / 10n ** 18n) * 99n / 100n, nonce: 1n } },
  ];
  const purpose = `blind-order-v1:${settlement.toLowerCase()}:${id}`;
  run.posts = [];
  for (const { acc, o } of orders) {
    const msg = (await pub.readContract({ address: settlement, abi, functionName: "orderMessage", args: [o] })) as Hex;
    const sig = toHex(pqcSign(acc.pqc.secretKey, hexToBytes(msg)));
    const plaintext = hexToBytes(encodeAbiParameters(ORDER_T, [o, sig]));
    const env = seal({ chainId: NET.chainId, purpose, recipients: [recipientOf(keys)], plaintext });
    const p = await evmTx(`post sealed order (${env.length} bytes)`, "post", [id, toHex(env)]);
    run.posts.push(p.hash);
  }

  // 3. The agent commits its quote before anything can be opened.
  const maxNet = parseUnits("0.01", 18);
  const quoteExpiry = BigInt(Number(await pub.getBlockNumber()) + 300);
  const qmsg = (await pub.readContract({ address: settlement, abi, functionName: "quoteMessage", args: [id, bid, ask, maxNet, quoteExpiry] })) as Hex;
  const qsig = toHex(pqcSign(agent.pqc.secretKey, hexToBytes(qmsg)));
  const cm = await evmTx(`commit quote bid ${formatUnits(bid, 6)} ask ${formatUnits(ask, 6)} fUSD/fETH`, "commit", [id, bid, ask, maxNet, quoteExpiry, qsig]);
  run.commit = { hash: cm.hash, block: cm.block, bid: bid.toString(), ask: ask.toString(), mid: mid.toString(), maxNet: maxNet.toString() };

  // 4. Reveal the seed in a later block.
  while (Number(await pub.getBlockNumber()) <= cm.block) await sleep(700);
  const ob = await evmTx("open (reveal batch seed)", "open", [id, toHex(seed)]);
  run.open = { hash: ob.hash, block: ob.block };

  // 5. Anyone can now rebuild the key from the revealed seed and open every envelope from chain logs.
  const logs = await pub.getContractEvents({ address: settlement, abi, eventName: "Sealed", args: { batch: id }, fromBlock: BigInt(c.block), toBlock: BigInt(ob.block) });
  const opened = logs.map((l: any) => {
    const pt = openEnvelope({ chainId: NET.chainId, purpose, envelope: hexToBytes(l.args.envelope), keys: sealKeysFromSeed(seed) });
    const [o, sig] = decodeAbiParameters(ORDER_T, toHex(pt));
    return { o, sig };
  });
  console.log(`opened ${opened.length} envelopes from chain logs`);

  // 6. Settle: one transaction, every check on chain.
  const st = await evmTx("settle", "settle", [id, opened.map((x) => x.o), opened.map((x) => x.sig)], 1.2);
  const ev = (await pub.getContractEvents({ address: settlement, abi, eventName: "Settled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) }))[0] as any;
  const fills = (await pub.getContractEvents({ address: settlement, abi, eventName: "Filled", args: { batch: id }, fromBlock: BigInt(st.block), toBlock: BigInt(st.block) })) as any[];
  run.settle = { hash: st.hash, block: st.block, gas: st.rc.gasUsed.toString(), price: ev.args.price.toString(), makerBase: ev.args.makerBase.toString(), makerQuote: ev.args.makerQuote.toString() };
  console.log(`clearing price ${formatUnits(ev.args.price, 6)} fUSD/fETH (pool mid ${formatUnits(mid, 6)})`);
  for (const f of fills) console.log(`  ${f.args.user} ${f.args.buy ? "bought" : "sold"}: in ${f.args.amountIn} out ${f.args.amountOut}`);
  console.log(`maker base ${formatUnits(ev.args.makerBase, 18)} fETH, quote ${formatUnits(ev.args.makerQuote, 6)} fUSD`);

  // 7. What a plain x/amm swap would have paid at the open block, for the same inputs.
  const q = async (d: string, amt: bigint) => {
    const j = (await (await fetch(`${NET.rest}/qorechain/amm/v1/quote/exact_in?pool_id=3&denom_in=${encodeURIComponent(d)}&amount_in=${amt}`)).json()) as any;
    return j.amount_out ?? `refused: ${j.message}`;
  };
  run.vsAmm = [
    { user: "USER1", blind: fills.find((f) => f.args.buy)?.args.amountOut.toString(), amm: await q(denom("fUSD"), parseUnits("20", 6)) },
    { user: "USER2", blind: fills.find((f) => !f.args.buy)?.args.amountOut.toString(), amm: await q(denom("fETH"), parseUnits("0.004", 18)) },
  ];
  console.log("vs plain x/amm quote now:", JSON.stringify(run.vsAmm));
  await closeWindow(op);
  state.write({ firstBatch: run });
}

const cmd = process.argv[2];
await ({ deploy, stock, onboard, batch } as Record<string, () => Promise<unknown>>)[cmd]();
