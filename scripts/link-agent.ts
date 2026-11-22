// Link the market maker agent's key to the settler account, bound by an on-chain spending rule.
// The key may call only BlindSettlement's batch functions and can move at most 1 uqor a day.
//   BLIND_ENV=<path> npx tsx scripts/link-agent.ts          link (creates AGENT_LINK_KEY in the env file if missing)
//   BLIND_ENV=<path> npx tsx scripts/link-agent.ts status   show the rule and the linked keys
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { toFunctionSelector, toHex, type Hex } from "viem";
import { linkAuthenticatorMsgs, signAuthenticatorLinkEd25519, fetchSpendingRules, fetchAuthenticators, fetchAuthNonce } from "@qorechain/sdk";
import { account, broadcast, waitTx, readEnv, state, NET, artifact } from "../src/chain.ts";
import { agentLinkFrom } from "../src/engine/batch.ts";

const ENV = process.env.BLIND_ENV ?? ".env";
const J = (x: any) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v), 1);
const op = await account("OPERATOR");
const { settlement } = state.read() as { settlement: Hex };
// The batch lifecycle only. Not withdraw (that needs the agent's ML-DSA signature and pays only the treasury anyway).
const AGENT_FUNCTIONS = ["create", "post", "commit", "open", "settle"];
const AGENT_CALLS = (artifact("BlindSettlement").abi as any[]).filter((f) => f.type === "function" && AGENT_FUNCTIONS.includes(f.name)).map((f) => toFunctionSelector(f));

async function status() {
  console.log("account", op.cosmos, "settlement", settlement);
  console.log("rules", J(await fetchSpendingRules({ rest: NET.rest, address: op.cosmos })));
  console.log("keys", J(await fetchAuthenticators({ rest: NET.rest, address: op.cosmos })));
  const link = agentLinkFrom(process.env.AGENT_LINK_KEY ?? readEnv(ENV).AGENT_LINK_KEY);
  if (link) console.log("agent key", toHex(link.pk), "nonce", J(await fetchAuthNonce({ rest: NET.rest, address: op.cosmos, pubkey: link.pk })));
}

async function link() {
  if (AGENT_CALLS.length !== AGENT_FUNCTIONS.length) throw new Error("selector lookup failed");
  console.log("allowed selectors", AGENT_CALLS.join(" "));
  let seed = process.env.AGENT_LINK_KEY ?? readEnv(ENV).AGENT_LINK_KEY;
  if (!seed) { seed = toHex(randomBytes(32)); appendFileSync(ENV, `AGENT_LINK_KEY="${seed}"\n`); console.log("new AGENT_LINK_KEY written to", ENV); }
  const k = agentLinkFrom(seed)!;
  const allowedEvmCalls = AGENT_CALLS.map((sel) => `${settlement.toLowerCase()}/${sel}`);
  const proof = signAuthenticatorLinkEd25519({ chainId: NET.chainId, account: op.cosmos, privateKey: k.sk });
  const msgs = linkAuthenticatorMsgs({
    owner: op.cosmos, chainId: NET.chainId, scheme: "ed25519", pubkey: proof.pubkey, possessionProof: proof.possessionProof,
    permissions: ["evm"], expiryUnix: Math.floor(Date.now() / 1000) + 29 * 86400, label: "Blind market maker agent",
    spendingRule: { id: "blind-agent", perTxLimit: "1", dailyLimit: "1", allowedDenoms: ["uqor"], enabled: true, allowedEvmCalls },
  });
  const h = await broadcast(op, "hybrid", msgs, "600000");
  const r = await waitTx(h);
  console.log(`link: ${h} code ${r.code} height ${r.height}${r.code ? " " + r.log : ""}`);
  if (r.code) process.exit(1);
  await status();
}

if (process.argv[2] === "status") await status();
else await link();
