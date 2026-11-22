// Browser side chain work. The burner's keys are made here and never leave this browser.
import {
  generateMnemonic, deriveUnifiedAccount, buildRegisterPqcKeyMsg, signProofOfPossession,
  EthNativeSigner, openEvmWindowMsg, pqcSign, type UnifiedAccount,
} from "@qorechain/sdk";
import { seal } from "@qorechain/qoreseal";
import {
  createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, encodeFunctionData,
  hexToBytes, toHex, maxUint256, keccak256, type Hex,
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

async function signAndBroadcast(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[], fee = { uqor: "100000", gas: "800000" }) {
  const { accountNumber, sequence } = await api.account(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: rest() });
  const signBytesVersion = mode === "hybrid" ? await signer.resolveSignBytesVersion(CHAIN_ID) : undefined;
  const { txRawBytes } = signer.sign({
    chainId: CHAIN_ID, accountNumber: BigInt(accountNumber), sequence: BigInt(sequence),
    fee: { amount: [{ denom: "uqor", amount: fee.uqor }], gas: fee.gas }, messages, signBytesVersion,
  });
  const b = await api.broadcast(b64(txRawBytes));
  if (!b.hash || (b.code !== 0 && b.code !== undefined)) throw new Error(plainChainError(b.log ?? ""));
  return b.hash;
}

async function signAndSend(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[]) {
  const hash = await signAndBroadcast(acc, mode, messages);
  const r = await waitCosmos(hash);
  return { hash, height: r.height };
}

// ------------------------------------------------------------------ public lane: a plain x/amm swap, visible in the mempool
export const POOL_ID = "3";
export const bankDenom = (address: string) => `erc20:${address}`;

/** Bank balances of the burner's Cosmos side (the coins the public lane spends). */
export async function bankBalances(acc: UnifiedAccount, s: State) {
  const b = await fetch(`/api/rest/cosmos/bank/v1beta1/balances/${acc.cosmos}`).then((r) => r.json()).catch(() => ({ balances: [] }));
  const of = (d: string) => BigInt((b.balances ?? []).find((x: any) => x.denom === d)?.amount ?? "0");
  return { fUSD: of(bankDenom(s.tokens.fUSD.address)), fETH: of(bankDenom(s.tokens.fETH.address)), qor: of("uqor") };
}

export interface SwapParams { buy: boolean; amountIn: bigint; minOut: bigint }

/** The public lane's message: a plain MsgSwapExactIn on pool 3. */
export function swapMsg(sender: string, s: State, p: SwapParams) {
  const F = bankDenom(s.tokens.fUSD.address), E = bankDenom(s.tokens.fETH.address);
  return { typeUrl: "/qorechain.amm.v1.MsgSwapExactIn", value: {
    sender, poolId: POOL_ID, tokenIn: { denom: p.buy ? F : E, amount: p.amountIn.toString() },
    denomOut: p.buy ? E : F, minOut: p.minOut.toString(),
  } };
}

/** Sign and broadcast a public MsgSwapExactIn on pool 3. Returns as soon as the mempool has it. */
export async function publicSwap(acc: UnifiedAccount, s: State, p: SwapParams) {
  return signAndBroadcast(acc, "hybrid", [swapMsg(acc.cosmos, s, p)], { uqor: "50000", gas: "400000" });
}

/** Wait for a public swap to land and read what the account received from its events. */
export async function publicSwapResult(hash: string, who: string, denomOut: string) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`/api/rest/cosmos/tx/v1beta1/txs/${hash}`);
    const t = r.ok ? (await r.json()).tx_response : null;
    if (t) {
      if (t.code) throw new Error(plainSwapError(t.raw_log ?? ""));
      const got = (t.events ?? []).filter((e: any) => e.type === "coin_received").flatMap((e: any) => {
        const at = Object.fromEntries(e.attributes.map((x: any) => [x.key, x.value]));
        return at.receiver === who && String(at.amount).endsWith(denomOut) ? [BigInt(String(at.amount).slice(0, -denomOut.length))] : [];
      }).reduce((a: bigint, b: bigint) => a + b, 0n);
      return { height: Number(t.height), got };
    }
    await sleep(1200);
  }
  throw new Error("The chain did not confirm the public swap in time.");
}

function plainSwapError(log: string) {
  const l = log.toLowerCase();
  if (l.includes("slippage") || l.includes("min") && l.includes("out")) return "The public swap was refused: the price moved past your slippage before it landed.";
  if (l.includes("impact")) return "x/amm refused this size (over its 5% impact cap).";
  if (l.includes("insufficient")) return "Not enough test coins for the public swap.";
  return plainChainError(log);
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

// ------------------------------------------------------------------ who trades
export interface Order { user: Hex; batch: bigint; expiry: bigint; buy: boolean; amountIn: bigint; minOut: bigint; nonce: bigint }

/**
 * One account that can trade: the test account made in this browser, or a QoreX wallet.
 * Only the order signer and the public lane's sender differ; sealing, posting and results are shared.
 */
export interface Trader {
  kind: "burner" | "qorex";
  evm: string;
  cosmos: string;
  /** The ML-DSA-87 signature BlindSettlement checks for this order. */
  signOrder: (s: State, order: Order) => Promise<Uint8Array>;
  /** Broadcast the public lane's swap. Resolves with the Cosmos tx hash. */
  publicSwap: (s: State, p: SwapParams) => Promise<string>;
}

/** The browser test account: signs signedOrderBytes(order) with its own ML-DSA-87 key. */
export function burnerTrader(acc: UnifiedAccount): Trader {
  return {
    kind: "burner", evm: acc.evm, cosmos: acc.cosmos,
    signOrder: async (s, order) => {
      const msg = (await pub.readContract({ address: s.contract as Hex, abi: abi as any, functionName: "signedOrderBytes", args: [order] })) as Hex;
      return pqcSign(acc.pqc.secretKey, hexToBytes(msg));
    },
    publicSwap: (s, p) => publicSwap(acc, s, p),
  };
}

// ------------------------------------------------------------------ orders
/** A placed order. A swap goes on chain as a 32 byte fingerprint only; a limit order as a sealed envelope. */
export interface Built { envelope?: Hex; fingerprint?: Hex; bytes: number; order: Order; sig?: Hex; salt?: Hex }

export function minOutFor(buy: boolean, amountIn: bigint, mid: bigint, bps: bigint) {
  return buy ? (amountIn * SCALE * 10_000n) / (mid * (10_000n + bps)) : (amountIn * mid * (10_000n - bps)) / (SCALE * 10_000n);
}

export async function sealOrder(t: Trader, s: State, p: { buy: boolean; amountIn: bigint; bps: bigint; standing?: { blocks: bigint } }): Promise<Built> {
  const head = await pub.getBlockNumber();
  const mid = BigInt(s.pool.mid);
  const batch = p.standing ? 0n : BigInt(s.batch.id);
  const order: Order = {
    user: t.evm as Hex, batch, expiry: head + (p.standing ? p.standing.blocks : 400n), buy: p.buy,
    amountIn: p.amountIn, minOut: minOutFor(p.buy, p.amountIn, mid, p.bps), nonce: BigInt(Date.now()),
  };
  const sig = await t.signOrder(s, order);
  if (!p.standing) {
    // A swap: only its fingerprint leaves this browser before the price is locked.
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    return { fingerprint: fingerprintOf(order, toHex(sig), salt), bytes: 32, order, sig: toHex(sig), salt };
  }
  // A limit order waits across batches while you are offline, so it is sealed to the operator's standing key.
  const plaintext = hexToBytes(encodeAbiParameters(ORDER_T, [order, toHex(sig)]));
  const key = s.standingKey;
  const purpose = `blind-standing-v1:${s.contract.toLowerCase()}`;
  const env = seal({ chainId: CHAIN_ID, purpose, recipients: [{ mlkemPublicKey: hexToBytes(key.mlkem as Hex), x25519PublicKey: hexToBytes(key.x25519 as Hex) }], plaintext });
  return { envelope: toHex(env), bytes: env.length, order };
}

/** keccak256(abi.encode(order, keccak256(signature), salt)): the same as BlindSettlement.fingerprintOf. */
export function fingerprintOf(order: Order, sig: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([ORDER_T[0], { type: "bytes32" }, { type: "bytes32" }] as any, [order, keccak256(sig), salt]));
}

// ------------------------------------------------------------------ reveal, only after the price is locked on chain
interface Pending { batch: number; index: number; contract: string; order: Record<string, string | boolean>; signature: Hex; salt: Hex; at: number }
const PENDING = "blind.pending";
const loadPending = (): Pending[] => { try { return JSON.parse(localStorage.getItem(PENDING) ?? "[]"); } catch { return []; } };
const savePending = (x: Pending[]) => { try { localStorage.setItem(PENDING, JSON.stringify(x)); } catch { /* fine */ } };
const revealing = new Set<string>();

/** Watch the contract directly (not the server): once the batch's commit block is on chain and passed,
 *  hand the order over for its reveal. Retries until revealed or the window is over. */
export async function revealWhenLocked(p: Pending): Promise<"revealed" | "missed"> {
  const key = `${p.contract}:${p.batch}:${p.index}`;
  if (revealing.has(key)) return "revealed";
  revealing.add(key);
  try {
    for (let i = 0; i < 400; i++) {
      const b = (await pub.readContract({ address: p.contract as Hex, abi: abi as any, functionName: "batches", args: [BigInt(p.batch)] }).catch(() => null)) as any[] | null;
      const head = Number(await pub.getBlockNumber().catch(() => 0n));
      const commitBlock = b ? Number(b[1]) : 0;
      const done = (await pub.readContract({ address: p.contract as Hex, abi: abi as any, functionName: "revealedAs", args: [BigInt(p.batch), BigInt(p.index)] }).catch(() => null)) as Hex | null;
      if (done && !/^0x0+$/.test(done)) { savePending(loadPending().filter((x) => !(x.batch === p.batch && x.index === p.index && x.contract === p.contract))); return "revealed"; }
      if (b && Number(b[2]) > 0) break; // settled without it
      if (commitBlock && head > commitBlock + 20) break; // window over
      if (commitBlock && head > commitBlock) await api.reveal({ batch: p.batch, index: p.index, order: p.order, signature: p.signature, salt: p.salt }).catch(() => null);
      await sleep(1500);
    }
    savePending(loadPending().filter((x) => !(x.batch === p.batch && x.index === p.index && x.contract === p.contract)));
    return "missed";
  } finally { revealing.delete(key); }
}

/** After a reload: finish any reveal this browser still owes. */
export function resumeReveals() {
  for (const p of loadPending()) if (Date.now() - p.at < 30 * 60_000) revealWhenLocked(p);
}

/** Seal to the open batch and post. If intake just closed, reseal for the next batch and retry. */
export async function placeSwap(acc: Trader, p: { buy: boolean; amountIn: bigint; bps: bigint }, onSealed?: (b: Built) => void) {
  for (let i = 0; i < 6; i++) {
    const s = await api.state();
    if (!s.batch.taking) { await sleep(2500); continue; }
    const built = await sealOrder(acc, s, p);
    onSealed?.(built);
    const r = await api.order(built.fingerprint!);
    if (r.ok) {
      const o = built.order;
      const pending: Pending = { batch: r.body.batch, index: r.body.index, contract: s.contract, signature: built.sig!, salt: built.salt!, at: Date.now(),
        order: { user: o.user, batch: o.batch.toString(), expiry: o.expiry.toString(), buy: o.buy, amountIn: o.amountIn.toString(), minOut: o.minOut.toString(), nonce: o.nonce.toString() } };
      savePending([...loadPending(), pending]);
      revealWhenLocked(pending);
      return { ...r.body, built };
    }
    if (r.status !== 409) throw new Error(r.body?.error ?? "The order was not accepted.");
    await sleep(2500);
  }
  throw new Error("The batch kept closing before your order arrived. Try again.");
}

export async function placeLimit(acc: Trader, p: { buy: boolean; amountIn: bigint; bps: bigint; blocks: bigint }, onSealed?: (b: Built) => void) {
  for (let i = 0; i < 6; i++) {
    const s = await api.state();
    if (!s.batch.taking) { await sleep(2500); continue; }
    const built = await sealOrder(acc, s, { ...p, standing: { blocks: p.blocks } });
    onSealed?.(built);
    const r = await api.limit(built.envelope!);
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
