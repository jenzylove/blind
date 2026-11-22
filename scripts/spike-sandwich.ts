// Spike: can a bot watching QoreChain's public mempool get its x/amm swap in ahead of a victim's?
// Victim = USER1 (plain public swap, 3% slippage). Bot = USER2. Testnet only, test tokens.
//   BLIND_ENV=<path> npx tsx scripts/spike-sandwich.ts fund
//   BLIND_ENV=<path> npx tsx scripts/spike-sandwich.ts run [victimFUSD] [botFUSD] [botFeeMultiplier]
import { createHash } from "node:crypto";
import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, resolveSignBytesVersion } from "@qorechain/sdk";
import { parseUnits } from "viem";
import { account, send, NET, denom, balances, ensureRegistered, registry as chainRegistry } from "../src/chain.ts";
import { readPool, POOL_ID } from "../src/engine/batch.ts";
import { cpOut } from "../src/agent/policy.ts";

const [op, victim, bot] = await Promise.all([account("OPERATOR"), account("USER1"), account("USER2")]);
const RPC = "https://rpc-testnet.qore.host";
const t0 = Date.now(), ms = () => `${Date.now() - t0}ms`;

async function seq(addr: string) {
  const r = (await (await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${addr}`)).json()) as any;
  const a = r.account.base_account ?? r.account;
  return { accountNumber: Number(a.account_number), sequence: Number(a.sequence) };
}
const signBytesVersion = await resolveSignBytesVersion({ chainId: NET.chainId, rest: NET.rest } as any);
async function signTx(acc: any, msg: any, feeUqor: number, gas = 400_000) {
  const { accountNumber, sequence } = await seq(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: NET.rest, registry: chainRegistry } as any);
  const { txRawBytes } = await (signer as any).sign({ chainId: NET.chainId, accountNumber, sequence, signBytesVersion, fee: { amount: [{ denom: "uqor", amount: String(feeUqor) }], gas: String(gas) }, messages: [msg] });
  return txRawBytes as Uint8Array;
}
let client: StargateClient;
const push = async (raw: Uint8Array) => (await client.broadcastTxSync(raw)).toString();
/** Sign and broadcast without waiting for the block. Returns the tx hash. */
const fire = async (acc: any, msg: any, feeUqor: number, gas = 400_000) => push(await signTx(acc, msg, feeUqor, gas));
const swap = (acc: any, inDenom: string, amount: bigint, outDenom: string, minOut: bigint) => ({ typeUrl: "/qorechain.amm.v1.MsgSwapExactIn",
  value: { sender: acc.cosmos, poolId: POOL_ID, tokenIn: { denom: inDenom, amount: amount.toString() }, denomOut: outDenom, minOut: minOut.toString() } });
async function txResult(hash: string) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
    if (r.ok) { const b = (await r.json()) as any; return { height: Number(b.tx_response.height), code: b.tx_response.code, log: b.tx_response.raw_log, events: b.tx_response.events }; }
    await new Promise((ok) => setTimeout(ok, 700));
  }
  throw new Error("not included " + hash);
}
async function orderInBlock(height: number) {
  const b = (await (await fetch(`${RPC}/block?height=${height}`)).json()) as any;
  return (b.result.block.data.txs ?? []).map((t: string) => createHash("sha256").update(Buffer.from(t, "base64")).digest("hex").toUpperCase());
}
const received = (ev: any[], who: string, d: string) => ev.filter((e) => e.type === "coin_received").flatMap((e) => {
  const at = Object.fromEntries(e.attributes.map((a: any) => [a.key, a.value]));
  return at.receiver === who && String(at.amount).endsWith(d) ? [BigInt(String(at.amount).slice(0, -d.length))] : [];
}).reduce((a, b) => a + b, 0n);

async function fund() {
  for (const a of [victim, bot]) {
    await send(op, "hybrid", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: a.cosmos,
      amount: [{ denom: denom("fUSD"), amount: parseUnits("40", 6).toString() }, { denom: "uqor", amount: "4000000" }].sort((x, y) => x.denom.localeCompare(y.denom)) } }], `fund ${a.cosmos}`);
    await ensureRegistered(a);
  }
}

async function run(vUsd = "5", bUsd = "6", mult = 10) {
  const F = denom("fUSD"), E = denom("fETH");
  const p0 = await readPool();
  const vIn = parseUnits(vUsd, 6), bIn = parseUnits(bUsd, 6);
  const vQuote = cpOut(p0.quote, p0.base, vIn, 30n);
  const vMin = (vQuote * 97n) / 100n; // 3% slippage, like a normal swap screen
  console.log(`pool mid ${(Number(p0.quote * 10n ** 18n / p0.base) / 1e6).toFixed(2)} fUSD/fETH; victim ${vUsd} fUSD, quote ${vQuote}, min ${vMin}`);

  // The bot: poll the public mempool; on the victim's swap, fire its own buy with a higher fee.
  client = await StargateClient.connect(RPC);
  const botRaw = await signTx(bot, swap(bot, F, bIn, E, 0n), 50_000 * mult); // pre-signed, ready to fire
  let botHash = "", seenAt = "";
  const victimTag = Buffer.from(victim.cosmos);
  const watcher = (async () => {
    for (let i = 0; i < 600 && !botHash; i++) {
      const r = (await (await fetch(`${RPC}/unconfirmed_txs?limit=50`)).json()) as any;
      for (const t of r.result.txs ?? []) {
        const raw = Buffer.from(t, "base64");
        if (raw.includes(victimTag) && raw.includes(Buffer.from("MsgSwapExactIn"))) {
          seenAt = ms();
          botHash = await push(botRaw);
          console.log(`bot saw the victim in the mempool at ${seenAt}, fired front-run ${botHash} at ${ms()}`);
          return;
        }
      }
      await new Promise((ok) => setTimeout(ok, 40));
    }
  })();
  await new Promise((ok) => setTimeout(ok, 300));
  const vHash = await fire(victim, swap(victim, F, vIn, E, vMin), 50_000);
  console.log(`victim broadcast ${vHash} at ${ms()}`);
  await watcher;
  const v = await txResult(vHash);
  const vGot = received(v.events, victim.cosmos, E);
  console.log(`victim: height ${v.height} code ${v.code} got ${vGot} (quote ${vQuote}, ${vGot ? ((Number(vGot) / Number(vQuote) - 1) * 100).toFixed(2) + "%" : v.log?.slice(0, 120)})`);
  if (!botHash) { console.log("bot never saw the victim's tx in the mempool"); return; }
  const b = await txResult(botHash);
  const bGot = received(b.events, bot.cosmos, E);
  const order = b.height === v.height ? await orderInBlock(v.height) : [];
  console.log(`bot: height ${b.height} code ${b.code} got ${bGot}; same block: ${b.height === v.height}; order: ${b.height === v.height ? (order.indexOf(botHash) < order.indexOf(vHash) ? "BOT FIRST" : "victim first") : b.height < v.height ? "BOT FIRST (earlier block)" : "victim first (earlier block)"}`);
  // Back-run: sell what the bot bought.
  if (bGot > 0n) {
    const bk = await fire(bot, swap(bot, E, bGot, F, 0n), 50_000);
    const k = await txResult(bk);
    const back = received(k.events, bot.cosmos, F);
    console.log(`bot back-run ${bk}: got ${back} fUSD units for ${bIn} spent -> bot P&L ${(Number(back - bIn) / 1e6).toFixed(4)} fUSD (fees ${mult + 1}x0.05 QOR)`);
  }
}

if (process.argv[2] === "fund") await fund();
else await run(process.argv[3], process.argv[4], Number(process.argv[5] ?? 10));
