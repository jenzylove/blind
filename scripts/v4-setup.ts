// Contract v4 on testnet: owner and maker accounts, deploy, the owner's mandate, inventory, and the
// agent's linked key on the maker account (commit only).
//   BLIND_ENV=<path> npx tsx scripts/v4-setup.ts accounts | deploy | mandate | stock | link | status
import { randomBytes } from "node:crypto";
import { encodeFunctionData, hexToBytes, parseUnits, toFunctionSelector, toHex, type Hex } from "viem";
import { pqcSign, linkAuthenticatorMsgs, signAuthenticatorLinkEd25519, fetchSpendingRules, fetchAuthenticators, revokeAuthenticatorMsg } from "@qorechain/sdk";
import {
  account, artifact, evmWallet, pub, send, broadcast, waitTx, windowMsg, closeWindow, ensureRegistered, sleep, state, readEnv,
  TOKENS, denom, CONVERT_COIN, NET,
} from "../src/chain.ts";
import { agentLinkFrom } from "../src/engine/batch.ts";

const { abi, bytecode } = artifact("BlindSettlement");
const FEE_CAP = 150_000_000_000n;
const fees = { maxFeePerGas: FEE_CAP, maxPriorityFeePerGas: 1_000_000_000n };
const uqor = (gas: bigint) => (gas * FEE_CAP + 999_999_999_999n) / 1_000_000_000_000n;
const REVEAL_BLOCKS = 20n; // about 30 s at 1.45 s per block
const SETTLE_BLOCKS = 300n;

const [op, agent, hedger, owner, maker] = await Promise.all(["OPERATOR", "AGENT", "HEDGER", "OWNER", "MAKER"].map((r) => account(r as any)));
const J = (x: any) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v), 1);

async function opTx(to: Hex | undefined, data: Hex, gas: bigint, label: string, deployArgs?: any[]) {
  await send(op, "hybrid", [windowMsg(op, { blocks: 600n, maxTxs: 1n, maxValueUqor: uqor(gas), allowedTargets: to ? [to] : undefined })], `operator window: 1 tx (${label})`);
  await sleep(4000);
  try {
    const hash = to
      ? await evmWallet(op).sendTransaction({ to, data, gas, ...fees } as any)
      : await evmWallet(op).deployContract({ abi, bytecode, gas, args: deployArgs!, ...fees } as any);
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`${label}: ${hash} ${rc.status}${rc.contractAddress ? " at " + rc.contractAddress : ""}`);
    if (rc.status !== "success") throw new Error(`${label} reverted`);
    return rc;
  } finally { await sleep(2000); await closeWindow(op).catch(() => undefined); }
}

async function accounts() {
  for (const [a, name] of [[owner, "owner"], [maker, "maker"]] as const) {
    await send(op, "hybrid", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: a.cosmos, amount: [{ denom: "uqor", amount: "600000" }] } }], `fund ${name} ${a.cosmos}`);
    await ensureRegistered(a);
  }
  console.log("owner", owner.cosmos, owner.evm, "| maker", maker.cosmos, maker.evm);
}

async function deploy() {
  const prev = state.read() as any;
  const { v1, v2, v3, ...cur } = prev;
  state.write({ v1, v2, v3: v3 ?? cur });
  const args = [TOKENS.fETH.address, TOKENS.fUSD.address, agent.evm, maker.evm, owner.evm, op.evm, hedger.evm, REVEAL_BLOCKS, SETTLE_BLOCKS, NET.chainId];
  const rc = await opTx(undefined, "0x", 4_500_000n, "deploy BlindSettlement v4", args);
  state.write({ chainId: 9800, version: 4, settlement: rc.contractAddress, deployTx: rc.transactionHash, base: "fETH", quote: "fUSD",
    agent: agent.evm, maker: maker.evm, makerCosmos: maker.cosmos, owner: owner.evm, settler: op.evm, treasury: hedger.evm,
    revealBlocks: Number(REVEAL_BLOCKS), settleWindowBlocks: Number(SETTLE_BLOCKS), msgDomain: `qorechain-msg-v1|${NET.chainId}|`,
    firstBatch: undefined, stockTx: undefined });
}

async function mandate() {
  const { settlement } = state.read() as { settlement: Hex };
  const head = await pub.getBlockNumber();
  // 0.05 fETH per batch, 3% spread, the whole curve within 15% of the last price for 2,000 blocks,
  // 0.02 fETH or 100 fUSD out per day, valid for 30 days of blocks.
  const m = { maxNet: parseUnits("0.05", 18), maxSpreadBps: 300, bandBps: 1_500, bandWindow: 2_000n,
    dailyBaseOut: parseUnits("0.02", 18), dailyQuoteOut: parseUnits("100", 6), expiry: head + 1_800_000n };
  const nonce = (await pub.readContract({ address: settlement, abi, functionName: "mandateNonce" })) as bigint;
  const msg = (await pub.readContract({ address: settlement, abi, functionName: "mandateMessage", args: [m, nonce] })) as Hex;
  const sig = toHex(pqcSign(owner.pqc.secretKey, hexToBytes(msg)));
  await opTx(settlement, encodeFunctionData({ abi, functionName: "setMandate", args: [m, sig] }), 600_000n, "owner's ML-DSA-87 mandate");
  state.write({ mandate: J(m) && JSON.parse(J(m)) });
}

async function stock() {
  const { settlement } = state.read() as { settlement: Hex };
  const r = await send(op, "hybrid", [
    { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fETH"), amount: parseUnits("0.05", 18).toString() }, receiver: settlement, sender: op.cosmos } },
    { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fUSD"), amount: parseUnits("150", 6).toString() }, receiver: settlement, sender: op.cosmos } },
  ], "stock maker inventory: 0.05 fETH + 150 fUSD into v4", "1400000");
  state.write({ stockTx: r.hash });
}

/** Link the agent's ed25519 key to the maker account: it may call only commit on v4, and move no value. */
async function link() {
  const { settlement } = state.read() as { settlement: Hex };
  const k = agentLinkFrom(process.env.AGENT_LINK_KEY ?? readEnv(process.env.BLIND_ENV ?? ".env").AGENT_LINK_KEY)!;
  const commitSel = toFunctionSelector((abi as any[]).find((f) => f.type === "function" && f.name === "commit"));
  const proof = signAuthenticatorLinkEd25519({ chainId: NET.chainId, account: maker.cosmos, privateKey: k.sk });
  const msgs = linkAuthenticatorMsgs({
    owner: maker.cosmos, chainId: NET.chainId, scheme: "ed25519", pubkey: proof.pubkey, possessionProof: proof.possessionProof,
    permissions: ["evm"], expiryUnix: Math.floor(Date.now() / 1000) + 29 * 86400, label: "Blind market maker agent",
    spendingRule: { id: "blind-agent", perTxLimit: "1", dailyLimit: "1", allowedDenoms: ["uqor"], enabled: true,
      allowedEvmCalls: [`${settlement.toLowerCase()}/${commitSel}`] },
  });
  const keys = (await fetchAuthenticators({ rest: NET.rest, address: maker.cosmos }).catch(() => [])) as any[];
  const linked = keys.some((x) => String(x.pubkeyHex).toLowerCase() === toHex(k.pk).slice(2) && !x.revoked);
  const h = await broadcast(maker, "hybrid", linked ? [msgs[0]] : msgs, "600000");
  const r = await waitTx(h);
  console.log(`link agent key to maker: ${h} code ${r.code} ${r.code ? r.log : ""}`);
  await status();
}

/** A key belongs to one account: revoke the agent key from the operator (where v3 used it) first. */
async function unlinkOperator() {
  const k = agentLinkFrom(process.env.AGENT_LINK_KEY ?? readEnv(process.env.BLIND_ENV ?? ".env").AGENT_LINK_KEY)!;
  const h = await broadcast(op, "hybrid", [revokeAuthenticatorMsg({ owner: op.cosmos, scheme: "ed25519", pubkey: k.pk })], "400000");
  const r = await waitTx(h);
  console.log(`revoke agent key on operator: ${h} code ${r.code} ${r.code ? r.log : ""}`);
}

async function status() {
  const st = state.read() as any;
  console.log("v4", st.settlement, "maker", st.makerCosmos);
  console.log("rules", J(await fetchSpendingRules({ rest: NET.rest, address: maker.cosmos }).catch((e) => String(e))));
  const mnd = await pub.readContract({ address: st.settlement, abi, functionName: "mandate" }).catch((e) => String(e));
  console.log("mandate", J(mnd));
}

const cmd = process.argv[2];
await ({ accounts, deploy, mandate, stock, link, unlinkOperator, status } as Record<string, () => Promise<unknown>>)[cmd]();
