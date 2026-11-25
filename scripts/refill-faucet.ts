// Refill the faucet: the hedger turns some of its ERC-20 fUSD (and fETH) back into bank coin for the operator,
// which funds test accounts.   BLIND_ENV=<path> npx tsx scripts/refill-faucet.ts <fUSD> [fETH]
import { parseUnits } from "viem";
import { account, send, TOKENS, CONVERT_ERC20 } from "../src/chain.ts";
const [usd = "250", eth = "0"] = process.argv.slice(2);
const [op, hedger] = await Promise.all([account("OPERATOR"), account("HEDGER")]);
const msgs: any[] = [{ typeUrl: CONVERT_ERC20, value: { contractAddress: TOKENS.fUSD.address, amount: parseUnits(usd, 6).toString(), receiver: op.cosmos, sender: hedger.cosmos } }];
if (Number(eth) > 0) msgs.push({ typeUrl: CONVERT_ERC20, value: { contractAddress: TOKENS.fETH.address, amount: parseUnits(eth, 18).toString(), receiver: op.cosmos, sender: hedger.cosmos } });
await send(hedger, "hybrid", msgs, `refill faucet: ${usd} fUSD${Number(eth) > 0 ? ` + ${eth} fETH` : ""} from the hedger to the operator`, "1500000");
