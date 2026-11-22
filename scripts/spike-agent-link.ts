// Spike: can an agent key, linked to an account with on-chain spending rules, make only the
// EVM calls we allow? Runs on USER1 (a test account), never the live operator.
//   BLIND_ENV=<path> npx tsx scripts/spike-agent-link.ts
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, toFunctionSelector, type Hex } from "viem";
import {
  linkAuthenticatorMsgs, signAuthenticatorLinkEd25519, buildPhantomExecuteEvm, resolveEvmAuthDigestVersion,
  fetchAuthNonce, fetchSpendingRules, fetchAuthenticators, decodeAuthenticatorExecutions,
} from "@qorechain/sdk";
import { account, broadcast, waitTx, NET, TOKENS, pub, ERC20_ABI, balances } from "../src/chain.ts";

const u1 = await account("USER1");
const SETTLEMENT = "0xbdbd8fa8247a9bbc598f72cb46a2c7e3194ef3cf" as Hex;
const J = (x: any) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
const sk = randomBytes(32);
const pk = ed25519.getPublicKey(sk);
const APPROVE = toFunctionSelector("approve(address,uint256)");
const TRANSFER = toFunctionSelector("transfer(address,uint256)");
console.log("USER1", u1.cosmos, u1.evm, "balances", JSON.stringify(await balances(u1.cosmos)).slice(0, 200));

// 1. Link the key with a rule: 0.2 QOR per tx, 1 QOR a day, only fUSD.approve.
const rule = { id: "spike-agent", perTxLimit: "200000", dailyLimit: "1000000", allowedDenoms: ["uqor"], enabled: true,
  allowedEvmCalls: [`${TOKENS.fUSD.address.toLowerCase()}/${APPROVE}`, `${SETTLEMENT.toLowerCase()}/${toFunctionSelector("batchCount()")}`] };
const proof = signAuthenticatorLinkEd25519({ chainId: NET.chainId, account: u1.cosmos, privateKey: sk });
const msgs = linkAuthenticatorMsgs({ owner: u1.cosmos, chainId: NET.chainId, scheme: "ed25519", pubkey: proof.pubkey, permissions: ["evm"],
  expiryUnix: Math.floor(Date.now() / 1000) + 7 * 86400, label: "blind spike agent", possessionProof: proof.possessionProof, spendingRule: rule });
const lh = await broadcast(u1, "hybrid", msgs, "600000");
const lr = await waitTx(lh);
console.log(`link: ${lh} code ${lr.code} ${lr.code ? lr.log : ""}`);
if (lr.code) process.exit(1);
console.log("rules", J(await fetchSpendingRules({ rest: NET.rest, address: u1.cosmos })).slice(0, 400));
console.log("keys", J(await fetchAuthenticators({ rest: NET.rest, address: u1.cosmos })).slice(0, 400));

const wallet = { publicKey: pk, signMessage: async (m: Uint8Array) => ed25519.sign(m, sk) };
const digestVersion = await resolveEvmAuthDigestVersion({ rest: NET.rest } as any).catch(() => "v2" as const);
const spender = "0x000000000000000000000000000000000000b11d" as Hex;

async function exec(label: string, to: Hex, data: Hex) {
  const n = await fetchAuthNonce({ rest: NET.rest, address: u1.cosmos, pubkey: pk });
  const m = await buildPhantomExecuteEvm({ wallet, relayer: u1.cosmos, chainId: NET.chainId, account: u1.cosmos, to, value: "0",
    data: Buffer.from(data.slice(2), "hex"), gasLimit: 120000, nonce: (n as any).nonce ?? n, digestVersion: digestVersion as any });
  const h = await broadcast(u1, "hybrid", [m], "400000");
  const r = await waitTx(h);
  let execs: any = null;
  try { execs = decodeAuthenticatorExecutions(r.raw ?? r); } catch { /* read the log instead */ }
  console.log(`${label}: ${h} code ${r.code}${r.code ? " log " + String(r.log).slice(0, 220) : ""}${execs ? " execs " + J(execs).slice(0, 200) : ""}`);
  return r;
}

const before = await pub.readContract({ address: TOKENS.fUSD.address, abi: ERC20_ABI as any, functionName: "allowance", args: [u1.evm, spender] }).catch(() => "n/a");
await exec("ALLOWED fUSD.approve", TOKENS.fUSD.address, encodeFunctionData({ abi: ERC20_ABI as any, functionName: "approve", args: [spender, 777n] }));
const after = await pub.readContract({ address: TOKENS.fUSD.address, abi: ERC20_ABI as any, functionName: "allowance", args: [u1.evm, spender] }).catch(() => "n/a");
console.log(`allowance before ${before} after ${after}`);
await exec("REFUSE fUSD.transfer", TOKENS.fUSD.address, encodeFunctionData({ abi: ERC20_ABI as any, functionName: "transfer", args: [spender, 1n] }));
await exec("REFUSE fETH.approve", TOKENS.fETH.address, encodeFunctionData({ abi: ERC20_ABI as any, functionName: "approve", args: [spender, 1n] }));
await exec("ALLOWED BlindSettlement.batchCount", SETTLEMENT, toFunctionSelector("batchCount()") as Hex);
await exec("REFUSE BlindSettlement.withdrawNonce (not listed)", SETTLEMENT, toFunctionSelector("withdrawNonce()") as Hex);
console.log("nonce now", J(await fetchAuthNonce({ rest: NET.rest, address: u1.cosmos, pubkey: pk })));
