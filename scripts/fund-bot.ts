// Create (if needed), fund and register the public-swap bot's account.
//   BLIND_ENV=<path> npx tsx scripts/fund-bot.ts
import { parseUnits } from "viem";
import { account, send, denom, ensureRegistered, balances } from "../src/chain.ts";

const [op, bot] = await Promise.all([account("OPERATOR"), account("BOT" as any)]);
console.log("bot", bot.cosmos, "before", JSON.stringify(await balances(bot.cosmos)));
await send(op, "hybrid", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: bot.cosmos, amount: [
  { denom: denom("fETH"), amount: parseUnits("0.04", 18).toString() }, { denom: denom("fUSD"), amount: parseUnits("120", 6).toString() }, { denom: "uqor", amount: "20000000" },
].sort((x, y) => x.denom.localeCompare(y.denom)) } }], "fund bot: 20 QOR, 120 fUSD, 0.04 fETH (bank)");
await ensureRegistered(bot);
console.log("after", JSON.stringify(await balances(bot.cosmos)));
