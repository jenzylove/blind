// Browser side chain work. The burner's keys are made here and never leave this browser.
import {
  generateMnemonic, deriveUnifiedAccount, buildRegisterPqcKeyMsg, signProofOfPossession,
  EthNativeSigner, openEvmWindowMsg, pqcSign, type UnifiedAccount,
} from "@qorechain/sdk";
import { seal } from "@qorechain/qoreseal";
import {
  createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, encodeFunctionData,
  hexToBytes, toHex, maxUint256, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import abi from "../abi.json";
import { api, type State } from "./api";

export const CHAIN_ID = "qorechain-diana";
export const EVM_RPC = "https://evm-testnet.qore.host";
import { EXPLORER } from "./const";
export { EXPLORER };
// The explorer indexes Cosmos hashes, so our server looks up the Cosmos hash of an EVM transaction and redirects.
export const txUrl = (h: string) => `/api/explorer/tx/${h}`;
export const SCALE = 10n ** 18n;
const FEES = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const rest = () => `${location.origin}/api/rest`;

export const chain = defineChain({
  id: 9800, name: "QoreChain testnet", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
export const pub = createPublicClient({ chain, transport: http(EVM_RPC) });

export const ORDER_T = [{ type: "tuple", components: [
  { name: "user", type: "address" }, { name: "batch", type: "uint64" }, { name: "expiry", type: "uint64" },
  { name: "buy", type: "bool" }, { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "nonce", type: "uint256" },
] }, { type: "bytes" }] as const;

const ERC20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

// ------------------------------------------------------------------ burner storage
const KEY = "blind.testaccount.v1";
export function storedWords(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function forgetAccount() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
export async function loadAccount(): Promise<UnifiedAccount | null> {
  const w = storedWords();
  return w ? deriveUnifiedAccount(w, 0) : null;
}
export async function newAccount(): Promise<UnifiedAccount> {
  const words = generateMnemonic();
  try { localStorage.setItem(KEY, words); } catch { /* storage blocked: account lives for this tab only */ }
  return deriveUnifiedAccount(words, 0);
}

// ------------------------------------------------------------------ cosmos lane
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function waitCosmos(hash: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await api.cosmosTx(hash).catch(() => ({ found: false }) as any);
    if (r.found) {
      if (r.code) throw new Error(plainChainError(r.log ?? ""));
      return r as { found: true; code: number; height: number };
    }
    await sleep(1500);
  }
  throw new Error("The chain did not confirm the transaction in time. Try again.");
}

async function signAndSend(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[]) {
  const { accountNumber, sequence } = await api.account(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: rest() });
  const signBytesVersion = mode === "hybrid" ? await signer.resolveSignBytesVersion(CHAIN_ID) : undefined;
  const { txRawBytes } = signer.sign({
    chainId: CHAIN_ID, accountNumber: BigInt(accountNumber), sequence: BigInt(sequence),
    fee: { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" }, messages, signBytesVersion,
  });
  const b = await api.broadcast(b64(txRawBytes));
  if (!b.hash || (b.code !== 0 && b.code !== undefined)) throw new Error(plainChainError(b.log ?? ""));
  const r = await waitCosmos(b.hash);
  return { hash: b.hash, height: r.height };
}

export async function fund(acc: UnifiedAccount) {
  const r = await api.fund(acc.cosmos, acc.evm);
  const c = await waitCosmos(r.hash);
  return { hash: r.hash, height: c.height };
}

export async function registerKey(acc: UnifiedAccount) {
  const st = await api.pqc(acc.cosmos);
  if (st.registered) return null;
  const proofOfPossession = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  return signAndSend(acc, "classical", [msg]);
}

export async function openWindow(acc: UnifiedAccount, targets: string[]) {
  const msg: any = openEvmWindowMsg({ sender: acc.cosmos, blocks: 600n, maxTxs: 2n, maxValue: 30000n });
  msg.value.allowedTargets = targets;
  const r = await signAndSend(acc, "hybrid", [msg]);
  await sleep(3000);
  return r;
}

// ------------------------------------------------------------------ EVM lane
export async function approveBoth(acc: UnifiedAccount, s: State) {
  const wallet = createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain, transport: http(EVM_RPC) });
  const out: string[] = [];
  const me = await api.me(acc.evm);
  for (const t of ["fUSD", "fETH"] as const) {
    if (me.approved[t]) continue;
    const hash = await wallet.sendTransaction({
      to: s.tokens[t].address as Hex, gas: 80_000n, ...FEES,
      data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [s.contract as Hex, maxUint256] }),
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("The approval did not go through on chain.");
    out.push(hash);
  }
  return out;
}

// ------------------------------------------------------------------ orders
export interface Built { envelope: Hex; bytes: number; order: { buy: boolean; amountIn: bigint; minOut: bigint; batch: bigint; expiry: bigint } }

export function minOutFor(buy: boolean, amountIn: bigint, mid: bigint, bps: bigint) {
  return buy ? (amountIn * SCALE * 10_000n) / (mid * (10_000n + bps)) : (amountIn * mid * (10_000n - bps)) / (SCALE * 10_000n);
}

export async function sealOrder(acc: UnifiedAccount, s: State, p: { buy: boolean; amountIn: bigint; bps: bigint; standing?: { blocks: bigint } }): Promise<Built> {
  const head = await pub.getBlockNumber();
  const mid = BigInt(s.pool.mid);
  const batch = p.standing ? 0n : BigInt(s.batch.id);
  const order = {
    user: acc.evm as Hex, batch, expiry: head + (p.standing ? p.standing.blocks : 400n), buy: p.buy,
    amountIn: p.amountIn, minOut: minOutFor(p.buy, p.amountIn, mid, p.bps), nonce: BigInt(Date.now()),
  };
  const msg = (await pub.readContract({ address: s.contract as Hex, abi: abi as any, functionName: "orderMessage", args: [order] })) as Hex;
  const sig = pqcSign(acc.pqc.secretKey, hexToBytes(msg));
  const plaintext = hexToBytes(encodeAbiParameters(ORDER_T, [order, toHex(sig)]));
  const key = p.standing ? s.standingKey : s.batch.publicKey;
  if (!key) throw new Error("The batch key is not published yet. Try again in a moment.");
  const purpose = p.standing ? `blind-standing-v1:${s.contract.toLowerCase()}` : `blind-order-v1:${s.contract.toLowerCase()}:${s.batch.id}`;
  const env = seal({ chainId: CHAIN_ID, purpose, recipients: [{ mlkemPublicKey: hexToBytes(key.mlkem as Hex), x25519PublicKey: hexToBytes(key.x25519 as Hex) }], plaintext });
  return { envelope: toHex(env), bytes: env.length, order };
}

/** Seal to the open batch and post. If intake just closed, reseal for the next batch and retry. */
export async function placeSwap(acc: UnifiedAccount, p: { buy: boolean; amountIn: bigint; bps: bigint }, onSealed?: (b: Built) => void) {
  for (let i = 0; i < 6; i++) {
    const s = await api.state();
    if (!s.batch.taking) { await sleep(2500); continue; }
    const built = await sealOrder(acc, s, p);
    onSealed?.(built);
    const r = await api.order(built.envelope);
    if (r.ok) return { ...r.body, built };
    if (r.status !== 409) throw new Error(r.body?.error ?? "The order was not accepted.");
    await sleep(2500);
  }
  throw new Error("The batch kept closing before your order arrived. Try again.");
}

export async function placeLimit(acc: UnifiedAccount, p: { buy: boolean; amountIn: bigint; bps: bigint; blocks: bigint }, onSealed?: (b: Built) => void) {
  for (let i = 0; i < 6; i++) {
    const s = await api.state();
    if (!s.batch.taking) { await sleep(2500); continue; }
    const built = await sealOrder(acc, s, { ...p, standing: { blocks: p.blocks } });
    onSealed?.(built);
    const r = await api.limit(built.envelope);
    if (r.ok) return { ...r.body, built };
    if (r.status !== 409) throw new Error(r.body?.error ?? "The order was not accepted.");
    await sleep(2500);
  }
  throw new Error("The batch kept closing before your order arrived. Try again.");
}

export function plainChainError(log: string) {
  const l = log.toLowerCase();
  if (l.includes("insufficient")) return "Not enough test QOR for the network fee.";
  if (l.includes("sequence")) return "The chain saw an older step still landing. Try again in a few seconds.";
  if (l.includes("window")) return "The EVM window is closed or used up. Open it again.";
  if (l.includes("pqc")) return "The chain refused the post quantum signature. Try again.";
  return "The chain refused the transaction.";
}
