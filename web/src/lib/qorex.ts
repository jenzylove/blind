// Trading from a QoreX wallet. QoreX signs; nothing secret ever reaches this page.
// window.qorex = { evm (EIP-1193), native (Keplr shaped), svm }. Only testnet (qorechain-diana, EVM 9800) is used.
import { evmToQor, qorechainRegistry } from "@qorechain/sdk";
import { encodeFunctionData, hexToBytes, maxUint256, type Hex } from "viem";
import abi from "../abi.json";
import { api, type State } from "./api";
import { CHAIN_ID, pub, swapMsg, type Trader } from "./chain";

export const EVM_CHAIN_HEX = "0x2648";
export const FAUCET_URL = "https://dashboard.qorechain.io/faucet";
export const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";
const MLDSA87_SIG_BYTES = 4627;

export const SWITCH_TESTNET = "Switch QoreX to testnet: click the version number at the bottom of the QoreX window seven times, then Developer mode, then Switch to testnet (diana).";
export const NEED_COIN60 = "In QoreX, open Your accounts, tap Add an Ethereum account (coin 60), switch to it and fund it from the faucet.";

interface Eip1193 { request: (a: { method: string; params?: unknown[] }) => Promise<any> }
interface QorexNative {
  enable: (chainId: string) => Promise<unknown>;
  getKey: (chainId: string) => Promise<{ bech32Address: string; algo?: string }>;
  signArbitrary: (chainId: string, signer: string, data: Uint8Array) => Promise<{ signatureType?: string; pq?: { algorithmId?: number; signature: string } }>;
  signAndBroadcast: (req: { chainId: string; messages: { typeUrl: string; value: Uint8Array }[]; gasLimit?: string; memo?: string }) => Promise<{ txHash: string; code: number; height?: number }>;
}
interface Qorex { evm: Eip1193; native: QorexNative }

export function qorex(): Qorex | null {
  const q = (window as any).qorex;
  return q && q.evm && q.native ? (q as Qorex) : null;
}

/** QoreX's words, made plain. Every refusal from the wallet lands here. */
export function plainQorexError(e: any): string {
  const m = String(e?.message ?? e ?? "");
  const l = m.toLowerCase();
  if (e?.code === 4001 || l.includes("rejected") || l.includes("denied")) return "You declined in QoreX. Nothing was sent.";
  if (l.includes("coin 118") || l.includes("coin-118") || l.includes("coin 60")) return NEED_COIN60;
  if (l.includes("locked")) return "QoreX is locked. Open QoreX, unlock it and try again.";
  if (l.includes("does not match the active network") || l.includes("mainnet") || l.includes("vladi")) return SWITCH_TESTNET;
  if (l.includes("insufficient")) return "Not enough test QOR in your QoreX account for the network fee. Get some from the QoreChain faucet.";
  return m.replace(/^QoreX:\s*/, "") || "QoreX did not answer.";
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface QorexConn { evm: Hex; cosmos: string }

/** Ask QoreX for its account. Checks testnet and that the account is a coin 60 one (0x and qor1 are the same 20 bytes). */
export async function connectQorex(silent = false): Promise<QorexConn | null> {
  const q = qorex();
  if (!q) throw new Error("QoreX is not installed in this browser.");
  const chainId = String(await q.evm.request({ method: "eth_chainId" })).toLowerCase();
  if (chainId !== EVM_CHAIN_HEX) throw new Error(SWITCH_TESTNET);
  const accs: string[] = await q.evm.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
  if (!accs?.length) { if (silent) return null; throw new Error("QoreX did not share an account."); }
  const evm = accs[0] as Hex;
  await q.native.enable(CHAIN_ID);
  const key = await q.native.getKey(CHAIN_ID);
  const cosmos = evmToQor(evm);
  if (key.bech32Address !== cosmos) throw new Error(NEED_COIN60);
  return { evm, cosmos };
}

/** Two approvals from QoreX, fUSD then fETH. QoreX opens its own one transaction EVM window inside each. */
export async function approveFromQorex(c: QorexConn, s: State, onTx?: (label: string, hash: string) => void) {
  const q = qorex();
  if (!q) throw new Error("QoreX is not installed in this browser.");
  const me = await api.me(c.evm);
  for (const t of ["fUSD", "fETH"] as const) {
    if (me.approved[t]) continue;
    const data = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve", args: [s.contract as Hex, maxUint256],
    });
    const hash = (await q.evm.request({ method: "eth_sendTransaction", params: [{ from: c.evm, to: s.tokens[t].address, data, gas: "0x13880" }] })) as Hex;
    onTx?.(`Approval ${t}`, hash);
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(`The ${t} approval did not go through on chain.`);
  }
}

/** A Trader whose orders QoreX signs with signArbitrary and whose public swaps QoreX broadcasts. */
export function qorexTrader(c: QorexConn): Trader {
  return {
    kind: "qorex", evm: c.evm, cosmos: c.cosmos,
    signOrder: async (s, order) => {
      const q = qorex();
      if (!q) throw new Error("QoreX is not installed in this browser.");
      // QoreX signs utf8("qorechain-msg-v1|qorechain-diana|") || data, which is exactly signedOrderBytes(order).
      const msg = (await pub.readContract({ address: s.contract as Hex, abi: abi as any, functionName: "orderMessage", args: [order] })) as Hex;
      let r;
      try { r = await q.native.signArbitrary(CHAIN_ID, c.cosmos, hexToBytes(msg)); } catch (e) { throw new Error(plainQorexError(e)); }
      const raw = r?.pq?.signature ?? "";
      const sig = /^(0x)?[0-9a-f]+$/i.test(raw) && raw.length >= MLDSA87_SIG_BYTES * 2 ? hexToBytes((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex) : b64ToBytes(raw);
      if (sig.length !== MLDSA87_SIG_BYTES) throw new Error("QoreX returned a signature Blind cannot use. Update QoreX and try again.");
      return sig;
    },
    publicSwap: async (s, p) => {
      const q = qorex();
      if (!q) throw new Error("QoreX is not installed in this browser.");
      const m = swapMsg(c.cosmos, s, p);
      const value = qorechainRegistry().encode(m);
      let r;
      try { r = await q.native.signAndBroadcast({ chainId: CHAIN_ID, messages: [{ typeUrl: m.typeUrl, value }], gasLimit: "400000" }); } catch (e) { throw new Error(plainQorexError(e)); }
      if (!r?.txHash) throw new Error("QoreX did not broadcast the public swap.");
      if (r.code) throw new Error("The chain refused the public swap.");
      return r.txHash;
    },
  };
}

/** Whether the account's ML-DSA-87 key is on chain with proof of possession, which the contract requires. */
export async function keyStatus(cosmos: string) {
  const p = await api.pqc(cosmos).catch(() => ({ registered: false, possessionProven: false }));
  return { registered: !!p.registered, proven: !!p.registered && p.possessionProven !== false };
}
