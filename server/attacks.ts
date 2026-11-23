// "Try to rob Blind": each attack is one real transaction on QoreChain testnet, sent from a dedicated
// ATTACKER account (or, for the stolen key attacks, signed with the agent's real linked key and relayed by the
// ATTACKER). Nothing here is simulated: the chain or the contract refuses every attempt, and the refusal is a
// transaction anyone can open. The log is public (GET /api/attacks).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { BaseError, decodeErrorResult, encodeFunctionData, hexToBytes, keccak256, toHex, type Hex } from "viem";
import { ed25519 } from "@noble/curves/ed25519.js";
import { buildPhantomExecuteEvm, fetchAuthNonce, pqcSign, resolveEvmAuthDigestVersion, type UnifiedAccount } from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";
import { account, artifact, broadcast, ensureRegistered, ERC20_ABI, evmWallet, NET, pub, readEnv, send, state, TOKENS, waitTx, windowMsg } from "../src/chain.ts";
import { agentLinkFrom, withAgentKey, FEES, type AgentLink } from "../src/engine/batch.ts";

const { abi } = artifact("BlindSettlement");
const DATA = process.env.DATA_DIR ?? "data";
const STORE = `${DATA}/attacks.json`;
const KEEP = 300;
const SIG_BYTES = 4627; // an ML-DSA-87 signature's length

export type RefusedBy = "chain rule" | "contract" | "signature check";
export interface AttackResult {
  name: string; title: string; attempted: string;
  refusedBy: RefusedBy | null; succeeded: boolean;
  reason: string;          // plain words
  chainSays?: string;      // the chain's or the contract's own words
  txHash?: string; block?: number; explorer?: string;
  dryRun?: boolean;        // only where a real transaction is impossible (none today)
  fingerprint?: string;    // guess-a-sealed-order: the fingerprint we tried to open
  at: string; ms?: number;
}

/** What each attack tries, in plain words. The page shows these rows. */
export const ATTACKS = [
  { name: "steal-agent-key-drain", title: "Steal the agent's key and drain the market maker", tries: "Use the AI agent's real key to send 1 fUSD from the market maker's account to us." },
  { name: "steal-agent-key-withdraw", title: "Steal the agent's key and empty the inventory", tries: "Use the agent's real key to call withdraw on Blind." },
  { name: "steal-agent-key-settle", title: "Steal the agent's key and settle a batch", tries: "Use the agent's real key to call settle on Blind." },
  { name: "fake-commit", title: "Lock a fake price", tries: "From our own account, lock a wide price curve with a junk signature." },
  { name: "widen-mandate", title: "Loosen the owner's limits", tries: "Rewrite the owner's mandate with huge limits, signed with our own quantum safe key." },
  { name: "withdraw-inventory", title: "Take the inventory", tries: "Pull fETH out of Blind, signed with our own quantum safe key." },
  { name: "settle-as-operator", title: "Pretend to be the operator", tries: "Settle the latest batch from our own account." },
  { name: "guess-a-sealed-order", title: "Read a sealed order", tries: "Take the newest order fingerprint on chain and try to open it with a made up order." },
] as const;
export type AttackName = (typeof ATTACKS)[number]["name"];

/** The contract's errors, in plain words. */
const CONTRACT_SAYS: Record<string, string> = {
  NotMaker: "Blind refused it. Only the market maker's account may lock a price, and the agent's key on that account can do nothing else.",
  NotSettler: "Blind refused it. Only the operator's account may settle, and even the operator can only settle orders their owners signed and revealed.",
  BadReveal: "Blind refused it. Our made up order does not match the fingerprint. Only the order's owner holds the secret salt that opens it.",
  OverDailyLimit: "Blind refused it. The amount is over the owner's daily withdrawal limit.",
  BadToken: "Blind refused it. Only the two market tokens can leave the contract.",
  KeyNotProven: "Blind refused it. The key is not registered and proven on QoreChain.",
};

// ------------------------------------------------------------------ the public log
interface Store { totals: { tried: number; refused: number; succeeded: number }; log: AttackResult[] }
function load(): Store {
  try { if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8")); } catch { /* start fresh */ }
  return { totals: { tried: 0, refused: 0, succeeded: 0 }, log: [] };
}
export const attackLog = {
  data: load(),
  add(r: AttackResult) {
    const d = this.data;
    d.totals.tried++;
    if (r.succeeded) d.totals.succeeded++; else d.totals.refused++;
    d.log.unshift(r);
    d.log.length = Math.min(d.log.length, KEEP);
    mkdirSync(DATA, { recursive: true });
    writeFileSync(STORE, JSON.stringify(d, null, 1));
  },
};

// ------------------------------------------------------------------ the lab
export class AttackLab {
  private queue: Promise<unknown> = Promise.resolve();
  private windowUntil = 0;
  constructor(public attacker: UnifiedAccount, public settlement: Hex, public maker: { cosmos: string; evm: Hex }, public link: AgentLink | undefined, public revealWindow: number) {}

  /** The ATTACKER account from ATTACKER_MNEMONIC (env file locally). Returns a plain reason when it cannot run. */
  static async create(): Promise<AttackLab | string> {
    if (process.env.NODE_ENV === "production" && !process.env.ATTACKER_MNEMONIC) return "The attack lab is not switched on on this server yet.";
    const dep = state.read() as any;
    if (!dep.maker || !dep.makerCosmos) return "This contract has no market maker account.";
    let attacker: UnifiedAccount;
    try { attacker = await account("ATTACKER"); } catch { return "The attack lab has no attacker account yet."; }
    const link = agentLinkFrom(process.env.AGENT_LINK_KEY ?? readEnv(process.env.BLIND_ENV ?? ".env").AGENT_LINK_KEY);
    return new AttackLab(attacker, dep.settlement as Hex, { cosmos: dep.makerCosmos, evm: dep.maker as Hex }, link, Number(dep.revealBlocks ?? 20));
  }

  /** One attack at a time: they share the ATTACKER's account sequence. */
  run(name: string): Promise<AttackResult> {
    const def = ATTACKS.find((a) => a.name === name);
    if (!def) return Promise.reject(Object.assign(new Error("unknown attack"), { status: 404 }));
    const p = this.queue.then(() => this.attempt(def));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async attempt(def: (typeof ATTACKS)[number]): Promise<AttackResult> {
    const t0 = Date.now();
    const base = { name: def.name, title: def.title, attempted: def.tries, at: new Date().toISOString() };
    const r = await this.dispatch(def.name);
    const out: AttackResult = { ...base, ...r, explorer: r.txHash ? `/api/explorer/tx/${r.txHash}` : undefined, ms: Date.now() - t0 };
    attackLog.add(out);
    return out;
  }

  private async dispatch(name: AttackName): Promise<Omit<AttackResult, "name" | "title" | "attempted" | "at">> {
    const c = this.settlement;
    const blind = (functionName: string, args: any[]) => encodeFunctionData({ abi, functionName, args });
    switch (name) {
      // a to c: the agent's real linked key, used for something other than commit. QoreChain checks the spending rule.
      case "steal-agent-key-drain":
        return this.withAgentKey(TOKENS.fUSD.address, encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [this.attacker.evm as Hex, 1n] }));
      case "steal-agent-key-withdraw":
        return this.withAgentKey(c, blind("withdraw", [TOKENS.fETH.address, 1n, "0x"]));
      case "steal-agent-key-settle": {
        const id = await this.read<bigint>("batchCount", []);
        return this.withAgentKey(c, blind("settle", [id, [], [], []]));
      }
      // d to h: the ATTACKER's own account, straight at the contract.
      case "fake-commit": {
        const id = await this.read<bigint>("batchCount", []);
        const head = await pub.getBlockNumber();
        const p = 2_800n * 10n ** 6n; // fUSD per fETH, scaled like the contract's prices
        const curve = { bid: p / 2n, ask: p * 2n, bidMax: p / 10n, askMax: p * 10n, maxNet: 10n ** 18n };
        return this.evm(c, blind("commit", [id, curve, head + 300n, toHex(randomBytes(SIG_BYTES))]), 300_000n);
      }
      case "widen-mandate": {
        const huge = { maxNet: 10n ** 24n, maxSpreadBps: 9_999, bandBps: 9_999, bandWindow: 1n, dailyBaseOut: 10n ** 24n, dailyQuoteOut: 10n ** 15n, expiry: 2n ** 63n };
        const nonce = await this.read<bigint>("mandateNonce", []);
        const msg = await this.read<Hex>("mandateMessage", [huge, nonce]);
        const sig = toHex(pqcSign(this.attacker.pqc.secretKey, hexToBytes(msg)));
        return this.evm(c, blind("setMandate", [huge, sig]), 900_000n, "mandate");
      }
      case "withdraw-inventory": {
        // Stay under the daily cap so the contract reaches the signature check.
        const m = await this.read<any[]>("mandate", []);
        const day = BigInt(Math.floor(Date.now() / 86_400_000));
        const done = await this.read<bigint>("withdrawnOn", [TOKENS.fETH.address, day]);
        const room = BigInt(m[4]) - done;
        const amount = room > 10n ** 15n ? 10n ** 15n : room > 0n ? room : 1n;
        const nonce = await this.read<bigint>("withdrawNonce", []);
        const msg = await this.read<Hex>("withdrawMessage", [TOKENS.fETH.address, amount, nonce]);
        const sig = toHex(pqcSign(this.attacker.pqc.secretKey, hexToBytes(msg)));
        return this.evm(c, blind("withdraw", [TOKENS.fETH.address, amount, sig]), 900_000n, "withdraw");
      }
      case "settle-as-operator": {
        const id = await this.read<bigint>("batchCount", []);
        return this.evm(c, blind("settle", [id, [], [], []]), 200_000n);
      }
      case "guess-a-sealed-order": return this.guess();
    }
  }

  // ---------------------------------------------------------------- guess a sealed order
  private async guess() {
    const target = await this.newestSealed();
    if (!target) throw new Error("no order has been posted on this contract yet");
    const order = { user: this.attacker.evm as Hex, batch: target.id, expiry: 2n ** 63n, buy: true, amountIn: 10n ** 6n, minOut: 1n, nonce: BigInt(Date.now()) };
    const data = encodeFunctionData({ abi, functionName: "reveal", args: [target.id, target.index, order, toHex(randomBytes(SIG_BYTES)), keccak256(randomBytes(32))] });
    const r = await this.evm(this.settlement, data, 300_000n, "reveal");
    const fp = target.fp;
    if (r.chainSays === "BadPhase()") {
      r.reason = target.revealed
        ? `Blind refused it. Batch ${target.id} is past its reveal window, so nobody can open or swap an order in it now.`
        : `Blind refused it. Batch ${target.id} is not in its reveal window, and outside it nobody can open an order. On chain this order is only a fingerprint: ${fp.slice(0, 18)}…`;
    }
    return { ...r, fingerprint: fp };
  }

  /** The newest posted fingerprint, preferring one its owner never revealed (still sealed for good). */
  private async newestSealed() {
    const count = Number(await this.read<bigint>("batchCount", []));
    let fallback: { id: bigint; index: bigint; fp: Hex; revealed: boolean } | null = null;
    for (let id = count; id >= 1 && id > count - 30; id--) {
      const b = await this.read<any[]>("batches", [BigInt(id)]);
      const posted = Number(b[4]);
      for (let i = posted - 1; i >= 0; i--) {
        const fp = await this.read<Hex>("fingerprint", [BigInt(id), BigInt(i)]);
        const rev = await this.read<Hex>("revealedAs", [BigInt(id), BigInt(i)]);
        const sealed = /^0x0+$/.test(rev);
        if (sealed) return { id: BigInt(id), index: BigInt(i), fp, revealed: false };
        fallback ??= { id: BigInt(id), index: BigInt(i), fp, revealed: true };
      }
    }
    return fallback;
  }

  // ---------------------------------------------------------------- the two lanes
  private read<T>(functionName: string, args: any[]) {
    return pub.readContract({ address: this.settlement, abi, functionName, args }) as Promise<T>;
  }

  /** A scoped EVM window on the ATTACKER: target = BlindSettlement only. */
  private async ensureWindow() {
    const head = Number(await pub.getBlockNumber());
    if (this.windowUntil - head > 60) return;
    const w: any = await evmWindowStatus({ rest: NET.rest, address: this.attacker.cosmos });
    const txs = Number(w.remainingTxs ?? w.remaining_txs ?? 0), blocks = Number(w.remainingBlocks ?? w.remaining_blocks ?? 0);
    if (w.found && w.live !== false && txs > 2 && blocks > 60) { this.windowUntil = head + blocks; return; }
    await ensureRegistered(this.attacker);
    await send(this.attacker, "hybrid", [windowMsg(this.attacker, { blocks: 3000n, maxTxs: 40n, maxValueUqor: 40n * 150_000n, allowedTargets: [this.settlement] })],
      "attacker window: 40 txs / 3000 blocks, target = BlindSettlement only");
    this.windowUntil = head + 3000;
    await new Promise((ok) => setTimeout(ok, 3000));
  }

  /** The contract's own error for this call, read before sending (eth_call against the live contract). */
  private async contractError(to: Hex, data: Hex): Promise<string | null> {
    try { await pub.call({ account: this.attacker.evm as Hex, to, data }); return null; }
    catch (e) {
      let raw: Hex | undefined;
      if (e instanceof BaseError) e.walk((x: any) => { if (typeof x?.data === "string" && x.data.startsWith("0x")) { raw = x.data; return true; } return false; });
      if (raw && raw.length >= 10) {
        try { const d = decodeErrorResult({ abi, data: raw }); return `${d.errorName}(${(d.args ?? []).join(", ")})`; } catch { return raw.slice(0, 10); }
      }
      return String((e as any)?.shortMessage ?? (e as Error).message).slice(0, 160);
    }
  }

  /** A real EVM transaction from the ATTACKER with a fixed gas limit, sent even though it will revert,
   *  so the revert is recorded on chain. */
  private async evm(to: Hex, data: Hex, gas: bigint, sig?: "mandate" | "withdraw" | "reveal") {
    await this.ensureWindow();
    const said = await this.contractError(to, data);
    const hash = await evmWallet(this.attacker).sendTransaction({ to, data, gas, ...FEES } as any);
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    const name = said?.replace(/\(.*$/, "") ?? "";
    if (rc.status === "success") {
      return { refusedBy: null, succeeded: true, reason: "It went through. This should never happen; we are looking at it.", chainSays: "success", txHash: hash, block: Number(rc.blockNumber) };
    }
    const signature = name === "BadSignature";
    const reason = signature
      ? sig === "mandate"
        ? "Blind refused it. Only the owner's ML-DSA-87 key can change the mandate. QoreChain's pqcVerify checked our signature against the owner's registered key and said no."
        : "Blind refused it. Inventory leaves only with the owner's ML-DSA-87 signature, and only to the treasury. QoreChain's pqcVerify checked our signature against the owner's key and said no."
      : CONTRACT_SAYS[name] ?? (name === "BadPhase" ? "Blind refused it. The batch is not in a phase where this call is allowed." : `Blind refused it (${said ?? "reverted"}).`);
    return { refusedBy: (signature ? "signature check" : "contract") as RefusedBy, succeeded: false, reason, chainSays: said ?? "reverted", txHash: hash, block: Number(rc.blockNumber) };
  }

  /** A MsgExecuteEVM on the market maker's account, signed with the agent's real linked key and relayed (fee paid)
   *  by the ATTACKER. QoreChain checks the key's spending rule before anything runs. */
  private withAgentKey(to: Hex, data: Hex) {
    const link = this.link;
    if (!link) throw new Error("the agent's key is not available on this server");
    return withAgentKey(async () => {
      await ensureRegistered(this.attacker);
      const { nonce } = await fetchAuthNonce({ rest: NET.rest, address: this.maker.cosmos, pubkey: link.pk });
      const digestVersion = await resolveEvmAuthDigestVersion({ rest: NET.rest } as any).catch(() => "v2");
      const msg = await buildPhantomExecuteEvm({
        wallet: { publicKey: link.pk, signMessage: async (m: Uint8Array) => ed25519.sign(m, link.sk) },
        relayer: this.attacker.cosmos, chainId: NET.chainId, account: this.maker.cosmos,
        to, value: "0", data: hexToBytes(data), gasLimit: 150_000, nonce, digestVersion: digestVersion as any,
      });
      const hash = await broadcast(this.attacker, "hybrid", [msg], "400000");
      const r = await waitTx(hash);
      const failed = r.events.find((e: any) => e.type === "abstractaccount_execution_failed");
      const chainSays = r.code ? String(r.log).slice(0, 300) : failed?.attributes.find((a: any) => a.key === "reason")?.value;
      if (!r.code && !failed) {
        return { refusedBy: null, succeeded: true, reason: "It went through. This should never happen; we are looking at it.", chainSays: "no refusal event", txHash: hash, block: r.height };
      }
      return {
        refusedBy: "chain rule" as RefusedBy, succeeded: false, txHash: hash, block: r.height, chainSays,
        reason: "QoreChain refused it. The agent's key may only call commit on Blind, and this call is not on its list. The chain checked the rule before anything ran.",
      };
    });
  }
}

// ------------------------------------------------------------------ HTTP
const PER_IP_MS = 15_000, PER_DAY = 300;
export function mountAttacks(app: any, ip: (c: any) => string) {
  let lab: AttackLab | null = null;
  let why: string | null = null;
  const ready = (async () => { const l = await AttackLab.create(); if (typeof l === "string") why = l; else lab = l; })().catch((e) => { why = `The attack lab could not start: ${String(e.message).slice(0, 120)}`; });
  const lastBy = new Map<string, number>();
  let today = { day: "", n: 0 };

  app.get("/api/attacks", async (c: any) => {
    await ready;
    const d = attackLog.data;
    return c.json({ available: !!lab, note: why, totals: d.totals, attacks: ATTACKS, log: d.log, attacker: lab ? lab.attacker.evm : null });
  });

  app.post("/api/attack/:name", async (c: any) => {
    await ready;
    if (!lab) return c.json({ error: why ?? "The attack lab is not available." }, 503);
    const name = c.req.param("name");
    if (!ATTACKS.some((a) => a.name === name)) return c.json({ error: "unknown attack" }, 404);
    const k = ip(c), now = Date.now();
    if (now - (lastBy.get(k) ?? 0) < PER_IP_MS) return c.json({ error: "One attempt every 15 seconds. Try again in a moment." }, 429);
    const day = new Date().toISOString().slice(0, 10);
    if (today.day !== day) today = { day, n: 0 };
    if (today.n >= PER_DAY) return c.json({ error: "Today's 300 attempts are used up. Come back tomorrow." }, 429);
    lastBy.set(k, now); today.n++;
    try { return c.json(await lab.run(name)); }
    catch (e: any) {
      today.n--; lastBy.delete(k);
      return c.json({ error: `The attempt did not reach the chain: ${String(e.shortMessage ?? e.message).slice(0, 160)}` }, 502);
    }
  });
}
