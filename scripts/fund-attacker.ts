// Create (if needed), fund and register the attack lab's ATTACKER account (server/attacks.ts).
// It holds only QOR for fees: every attack it sends is meant to be refused.
//   BLIND_ENV=<path> npx tsx scripts/fund-attacker.ts [qor, default 3]
import { account, send, ensureRegistered, balances } from "../src/chain.ts";

const qor = Number(process.argv[2] ?? 3);
const [op, attacker] = await Promise.all([account("OPERATOR"), account("ATTACKER")]);
console.log("attacker", attacker.cosmos, attacker.evm, "before", JSON.stringify(await balances(attacker.cosmos).catch(() => ({}))));
await send(op, "hybrid", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: attacker.cosmos, amount: [
  { denom: "uqor", amount: String(Math.round(qor * 1e6)) },
] } }], `fund attacker: ${qor} QOR`);
await ensureRegistered(attacker);
console.log("after", JSON.stringify(await balances(attacker.cosmos)));
