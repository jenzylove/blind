// Chain helpers for Blind on testnet qorechain-diana: Cosmos lane (hybrid signed), EVM lane, accounts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StargateClient } from "@cosmjs/stargate";
import { BinaryWriter } from "cosmjs-types/binary";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchPqcStatus, generateMnemonic,
  openEvmWindowMsg, closeEvmWindowMsg, signProofOfPossession, qorechainRegistry, type UnifiedAccount,
} from "@qorechain/sdk";

export const NET = { chainId: "qorechain-diana", rest: "https://api-testnet.qore.host", rpc: "https://rpc-testnet.qore.host", evm: "https://evm-testnet.qore.host" };
export const chain = defineChain({ id: 9800, name: "qorechain-diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [NET.evm] } } });
export const pub = createPublicClient({ chain, transport: http() });
export const TOKENS = {
  fUSD: { address: "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as const, decimals: 6 },
  fETH: { address: "0x02292293c13880a26242690eb70a0e42B8E91c28" as const, decimals: 18 },
};
export const denom = (t: keyof typeof TOKENS) => `erc20:${TOKENS[t].address}`;
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

// ---- env and accounts -------------------------------------------------------
export function readEnv(path = ".env") {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)="?(.*?)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
export const ROLES = ["OPERATOR", "AGENT", "HEDGER", "USER1", "USER2"] as const;
// Mnemonics live in a git-ignored env file outside the repo (BLIND_ENV), testnet only.
const ENV_PATH = process.env.BLIND_ENV ?? ".env";
export type Role = (typeof ROLES)[number];
export function ensureKeys() {
  const env = readEnv(ENV_PATH);
  let changed = false;
  for (const r of ROLES) if (!env[`${r}_MNEMONIC`]) { env[`${r}_MNEMONIC`] = generateMnemonic(); changed = true; }
  if (changed) writeFileSync(ENV_PATH, Object.entries(env).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
  return env;
}
export async function account(role: Role): Promise<UnifiedAccount> {
  return deriveUnifiedAccount(ensureKeys()[`${role}_MNEMONIC`], 0);
}

// ---- Cosmos lane ------------------------------------------------------------
// MsgConvertCoin is not in the SDK registry; encode it by hand.
// cosmos.evm.erc20.v1.MsgConvertCoin { Coin coin = 1; string receiver = 2; string sender = 3; }
const MsgConvertCoin = {
  encode(m: any, w = BinaryWriter.create()) {
    w.uint32(10).fork();
    w.uint32(10).string(m.coin.denom); w.uint32(18).string(m.coin.amount); w.ldelim();
    w.uint32(18).string(m.receiver); w.uint32(26).string(m.sender);
    return w;
  },
  decode(): any { throw new Error("decode not needed"); },
  fromPartial(m: any) { return m; },
};
export const CONVERT_COIN = "/cosmos.evm.erc20.v1.MsgConvertCoin";
const registry = qorechainRegistry([[CONVERT_COIN, MsgConvertCoin as any]]);

async function seq(addr: string) {
  const r = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${addr}`);
  if (r.status === 404) throw new Error(`account ${addr} does not exist on chain yet (fund it first)`);
  if (!r.ok) throw new Error(`account query HTTP ${r.status}`);
  const b = (await r.json()) as any;
  const a = b.account?.base_account ?? b.account ?? {};
  return { accountNumber: BigInt(a.account_number ?? "0"), sequence: BigInt(a.sequence ?? "0") };
}

export async function broadcast(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[], gas = "800000") {
  const { accountNumber, sequence } = await seq(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: NET.rest, registry });
  const t = await StargateClient.connect(NET.rpc);
  try {
    const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(Number(gas) / 8)) }], gas };
    const res = await signer.signAndBroadcast(t, { chainId: NET.chainId, accountNumber, sequence, fee: gas === "800000" ? FEE : fee, messages });
    return res.transactionHash as string;
  } finally { t.disconnect(); }
}

export async function waitTx(hash: string) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
    if (r.ok) {
      const b = (await r.json()) as any;
      return { code: b.tx_response?.code ?? 0, log: b.tx_response?.raw_log ?? "", height: Number(b.tx_response?.height ?? 0), gasUsed: Number(b.tx_response?.gas_used ?? 0), events: b.tx_response?.events ?? [] };
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw new Error(`tx ${hash} not committed`);
}

export async function send(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[], label: string, gas?: string) {
  const h = await broadcast(acc, mode, messages, gas);
  const r = await waitTx(h);
  console.log(`${label}: ${h} code ${r.code} height ${r.height} gas ${r.gasUsed}${r.code ? " log " + r.log : ""}`);
  if (r.code) throw new Error(`${label} failed: ${r.log}`);
  return { hash: h, ...r };
}

export async function balances(addr: string) {
  const b = (await (await fetch(`${NET.rest}/cosmos/bank/v1beta1/balances/${addr}`)).json()) as any;
  const out: Record<string, string> = {};
  for (const c of b.balances ?? []) out[c.denom] = c.amount;
  return out;
}

export async function ensureRegistered(acc: UnifiedAccount) {
  const st = await fetchPqcStatus({ rest: NET.rest, address: acc.cosmos });
  if (st.registered) return null;
  const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  return send(acc, "classical", [msg], `register ML-DSA key ${acc.cosmos}`);
}

export function windowMsg(acc: UnifiedAccount, o: { blocks: bigint; maxTxs: bigint; maxValueUqor: bigint; allowedTargets?: string[] }) {
  const m: any = openEvmWindowMsg({ sender: acc.cosmos, blocks: o.blocks, maxTxs: o.maxTxs, maxValue: o.maxValueUqor });
  if (o.allowedTargets?.length) m.value.allowedTargets = o.allowedTargets;
  return m;
}
export const closeWindow = (acc: UnifiedAccount) => send(acc, "hybrid", [closeEvmWindowMsg(acc.cosmos)], "close window");

export function evmWallet(acc: UnifiedAccount) {
  return createWalletClient({ account: privateKeyToAccount(acc.privateKey as `0x${string}`), chain, transport: http() });
}

// ---- Solidity (forge build output) ------------------------------------------
export function artifact(name: string) {
  const j = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as `0x${string}` };
}

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// Public testnet addresses and run records, committed so judges can check them.
const DEPLOY = "deployments/testnet.json";
export const state = {
  read: (): any => (existsSync(DEPLOY) ? JSON.parse(readFileSync(DEPLOY, "utf8")) : {}),
  write(patch: any) { writeFileSync(DEPLOY, JSON.stringify({ ...state.read(), ...patch }, null, 2) + "\n"); },
};
