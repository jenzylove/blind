// Blind web server: the batch loop, the relayer and the API the web app uses.
// Visitors' keys never reach this server: the browser makes a burner key, signs its own
// transactions and orders, and seals orders to the batch key. The server relays.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { isHex, type Hex } from "viem";
import { fetchPqcStatus } from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";
import { account, send, state, readEnv, NET, denom, CONVERT_COIN, TOKENS, pub, ERC20_ABI } from "../src/chain.ts";
import { Engine, readPool, makerInventory, agentLinkFrom } from "../src/engine/batch.ts";
import { fetchSpendingRules, fetchAuthenticators } from "@qorechain/sdk";
import { toHex, parseAbi, parseEventLogs } from "viem";
import { makeQuote, clearingPrice, cpOut, SCALE } from "../src/agent/policy.ts";
import { BatchLoop } from "./loop.ts";
import { relayCheck } from "./relay.ts";
import { SandwichBot } from "./bot.ts";

const [op, agent, hedger] = await Promise.all([account("OPERATOR"), account("AGENT"), account("HEDGER")]);
const dep = state.read();
const settlement = dep.settlement as Hex;
// The market maker agent acts through its own ed25519 key, linked on chain to the settler account with a
// spending rule that allows only BlindSettlement's batch functions (scripts/link-agent.ts).
const agentLink = agentLinkFrom(process.env.AGENT_LINK_KEY ?? readEnv(process.env.BLIND_ENV ?? ".env").AGENT_LINK_KEY);
if (!agentLink && process.env.NODE_ENV === "production") throw new Error("AGENT_LINK_KEY is required");
const engine = new Engine(settlement, op, agent, hedger, agentLink);
const STANDING_SEED = process.env.STANDING_SEED ?? readEnv(process.env.BLIND_ENV ?? ".env").STANDING_SEED;
if (!STANDING_SEED) throw new Error("STANDING_SEED (32 bytes hex) is required");
const loop = new BatchLoop(engine, STANDING_SEED);
setInterval(() => loop.markouts().catch(() => undefined), 30_000);

// The public-swap bot: a separate account that reads only the public mempool (server/bot.ts).
const botAcc = await account("BOT" as any).catch(() => null);
const bot = botAcc ? new SandwichBot(botAcc, `${process.env.DATA_DIR ?? "data"}/bot.json`) : null;
if (bot && process.env.BOT !== "off") bot.start().catch((e) => console.log(`[bot] failed to start: ${e.message}`));

const FUND = {
  uqor: process.env.FUND_UQOR ?? "450000",                  // 0.45 QOR: key registration, one window, two approvals, one public swap
  fUSD: process.env.FUND_FUSD ?? "15000000",                // 15 fUSD
  publicFUSD: process.env.FUND_PUBLIC_FUSD ?? "6000000",    // 6 fUSD and 0.002 fETH as bank coin, for the public x/amm lane
  publicFETH: process.env.FUND_PUBLIC_FETH ?? "2000000000000000",
  fETH: process.env.FUND_FETH ?? "5000000000000000",        // 0.005 fETH
  perDay: Number(process.env.FUND_PER_DAY ?? 150),
};
const funded = new Map<string, number>(); // ip or address -> last funded ms
let fundedToday = { day: new Date().toISOString().slice(0, 10), n: 0 };

const app = new Hono();
// The host's proxy appends the real client address last; earlier entries are whatever the client sent.
const ip = (c: any) => c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || c.req.header("x-real-ip") || "local";
const bad = (c: any, msg: string, code = 400) => c.json({ error: msg }, code);

// Posting an order costs the operator gas, so each network gets a modest allowance.
const posts = new Map<string, number[]>();
const POSTS_PER_MIN = Number(process.env.POSTS_PER_MIN ?? 6), POSTS_PER_DAY = Number(process.env.POSTS_PER_DAY ?? 120);
function postLimited(c: any): string | null {
  const k = ip(c), now = Date.now();
  const recent = (posts.get(k) ?? []).filter((t) => now - t < 86_400_000);
  if (recent.filter((t) => now - t < 60_000).length >= POSTS_PER_MIN) return "too many orders in the last minute; wait a moment";
  if (recent.length >= POSTS_PER_DAY) return "daily order limit reached for this network";
  recent.push(now); posts.set(k, recent);
  return null;
}

// ------------------------------------------------------------------ market and batch state
app.get("/api/state", async (c) => {
  const [count, pool] = await Promise.all([engine.read<bigint>("batchCount", []), readPool()]);
  const cur = loop.current;
  const taking = loop.phase === "waiting" || loop.phase === "intake";
  return c.json({
    chainId: NET.chainId, evmChainId: 9800, evmRpc: NET.evm, contract: settlement, tokens: TOKENS,
    agent: agent.evm, settler: op.evm, treasury: hedger.evm,
    phase: loop.phase,
    batch: cur
      ? { id: cur.id, taking, closesAt: cur.closesAt, publicKey: (cur as any).publicKey ?? null, created: true }
      : { id: Number(count) + 1, taking: true, closesAt: null, publicKey: loop.next.publicKey, created: false },
    standingKey: loop.standingPublicKey(),
    pool: { id: 3, base: pool.base.toString(), quote: pool.quote.toString(), mid: ((pool.quote * SCALE) / pool.base).toString() },
    standingOpen: loop.standing.length,
  });
});

// ------------------------------------------------------------------ the public-swap bot
app.get("/api/bot", (c) => (bot ? c.json(bot.stats()) : bad(c, "bot not running", 503)));
app.get("/api/bot/attempt/:hash", (c) => {
  if (!bot) return bad(c, "bot not running", 503);
  const a = bot.find(c.req.param("hash"));
  return a ? c.json(a) : bad(c, "the bot has not seen this transaction (yet)", 404);
});

/** Explorer links: the explorer indexes Cosmos hashes, so resolve an EVM hash first, then redirect. */
const cosmosOf = new Map<string, string>();
app.get("/api/explorer/tx/:hash", async (c) => {
  const h = c.req.param("hash");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(h)) return bad(c, "not a transaction hash");
  if (!h.startsWith("0x")) return c.redirect(`https://explore.qore.network/tx/${h.toUpperCase()}`);
  let cos = cosmosOf.get(h.toLowerCase());
  if (!cos) {
    const q = encodeURIComponent(`ethereum_tx.ethereumTxHash='${h.toLowerCase()}'`);
    const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs?query=${q}&pagination.limit=1`).then((x) => x.json()).catch(() => null) as any;
    cos = r?.tx_responses?.[0]?.txhash;
    if (cos) cosmosOf.set(h.toLowerCase(), cos);
  }
  return c.redirect(cos ? `https://explore.qore.network/tx/${cos}` : `https://explore.qore.network/search?q=${h}`);
});

/** The agent's linked key and the spending rule the chain enforces on it, read live from the chain. */
let agentCache: { at: number; v: any } | null = null;
app.get("/api/agent", async (c) => {
  if (agentCache && Date.now() - agentCache.at < 60_000) return c.json(agentCache.v);
  const [rules, keys] = await Promise.all([fetchSpendingRules({ rest: NET.rest, address: op.cosmos }), fetchAuthenticators({ rest: NET.rest, address: op.cosmos })]);
  const pk = agentLink ? toHex(agentLink.pk).slice(2).toLowerCase() : null;
  const key = (keys as any[]).find((k) => String(k.pubkeyHex).toLowerCase() === pk) ?? null;
  const v = JSON.parse(JSON.stringify({ account: op.cosmos, settlement, linked: !!key && !key.revoked, key, rules }, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
  agentCache = { at: Date.now(), v };
  return c.json(v);
});

/** What x/amm pays right now for this input, and what Blind would pay if the order were alone. */
app.get("/api/quote", async (c) => {
  const side = c.req.query("side"), amount = c.req.query("amount");
  if ((side !== "buy" && side !== "sell") || !amount || !/^\d+$/.test(amount)) return bad(c, "side=buy|sell&amount=<base units>");
  const a = BigInt(amount);
  const pool = await readPool();
  const inv = await makerInventory(settlement, hedger);
  const q = makeQuote(pool, { base: inv.contract.base + inv.hedger.base, quote: inv.contract.quote + inv.hedger.quote }, 0n);
  const curve = { bid: q.bid, ask: q.ask, bidMax: q.bidMax, askMax: q.askMax, maxNet: q.maxNet };
  const buy = side === "buy";
  const price = buy ? clearingPrice(curve, a, 0n) : clearingPrice(curve, 0n, a);
  const blindAlone = buy ? (a * SCALE) / price : (a * price) / SCALE;
  const impact = buy ? (a * 10_000n) / (pool.quote + a) : (a * 10_000n) / (pool.base + a);
  const amm = impact > 500n ? null : buy ? cpOut(pool.quote, pool.base, a, 30n) : cpOut(pool.base, pool.quote, a, 30n);
  const net = buy ? (a * SCALE) / price : a;
  return c.json({
    side, amountIn: amount, mid: q.mid.toString(),
    blindIfAlone: blindAlone.toString(), withinMakerSize: net <= q.maxNet,
    plainAmm: amm === null ? null : amm.toString(), ammRefused: amm === null,
    note: "Blind's figure assumes nobody trades the other side in your batch; matched flow clears closer to mid.",
  });
});

// ------------------------------------------------------------------ orders
app.post("/api/order", async (c) => {
  const lim = postLimited(c); if (lim) return bad(c, lim, 429);
  const b = await c.req.json().catch(() => ({}));
  if (!isHex(b.envelope) || b.envelope.length < 200) return bad(c, "envelope: sealed order as 0x hex");
  try { return c.json(await loop.submit(b.envelope as Hex)); }
  catch (e: any) { return bad(c, e.message, 409); }
});

app.post("/api/limit", async (c) => {
  const lim = postLimited(c); if (lim) return bad(c, lim, 429);
  const b = await c.req.json().catch(() => ({}));
  if (!isHex(b.envelope)) return bad(c, "envelope: standing order sealed to standingKey, as 0x hex");
  try { return c.json(await loop.submitStanding(b.envelope as Hex)); }
  catch (e: any) { return bad(c, e.message, 409); }
});

// ------------------------------------------------------------------ batches and proof
app.get("/api/batches", (c) => c.json({
  live: [...loop.records].reverse(),
  testRuns: loop.history,
  earlier: [...loop.earlier].reverse(),
  versions: {
    current: { contract: settlement, version: dep.version ?? 2 },
    previous: dep.v1 ? { contract: dep.v1.settlement } : null,
    all: [
      { version: dep.version ?? 2, contract: settlement, note: "current" },
      ...(dep.v2 ? [{ version: 2, contract: dep.v2.settlement, note: "quote curve; orders signed without QoreChain's message domain" }] : []),
      ...(dep.v1 ? [{ version: 1, contract: dep.v1.settlement, note: "flat band quote (the first miss)" }] : []),
    ],
  },
}));
// The first bytes of the newest sealed order on the current contract, read back from its Sealed event.
// The landing shows these so a visitor sees exactly what a bot reading the chain gets.
const SEALED_EVENT = parseAbi(["event Sealed(uint64 indexed batch, uint32 index, bytes envelope)"]);
let envCache: { at: number; v: { batch: number; version: number; txHash: string; bytes: number; hexHead: string } | null } | null = null;
app.get("/api/envelope/latest", async (c) => {
  if (!envCache || Date.now() - envCache.at > 60_000) {
    let v: NonNullable<typeof envCache>["v"] = null;
    for (const r of [...loop.records].reverse().slice(0, 5)) {
      const h = r.posts?.[0]?.hash as Hex | undefined;
      if (!h) continue;
      try {
        const rc = await pub.getTransactionReceipt({ hash: h });
        const ev = parseEventLogs({ abi: SEALED_EVENT, logs: rc.logs.filter((l) => l.address.toLowerCase() === settlement.toLowerCase()) })[0];
        if (!ev) continue;
        const env = ev.args.envelope as Hex;
        v = { batch: r.batch, version: dep.version ?? 2, txHash: h, bytes: (env.length - 2) / 2, hexHead: env.slice(2, 162) };
        break;
      } catch { /* try the next batch */ }
    }
    envCache = { at: Date.now(), v };
  }
  return envCache.v ? c.json(envCache.v) : bad(c, "no sealed order on the current contract yet", 404);
});

// The first version's test runs (flat quote, before the curve fix), read only, for the proof page.
const V1 = existsSync("deployments/batches.json") ? JSON.parse(readFileSync("deployments/batches.json", "utf8")) : [];
app.get("/api/batches/v1", (c) => c.json(V1));
app.get("/api/batch/:id", (c) => {
  const id = Number(c.req.param("id"));
  const v = Number(c.req.query("v") ?? dep.version ?? 2);
  // Each contract version numbers batches from 1: ?v=2 reads the previous version's batches.
  const r = v === (dep.version ?? 2) ? loop.records.find((x) => x.batch === id)
    : loop.earlier.find((x) => x.batch === id) ?? loop.history.find((x) => x.batch === id);
  return r ? c.json(r) : bad(c, "unknown batch", 404);
});

// ------------------------------------------------------------------ relayer: fund a burner
app.post("/api/fund", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const cosmos = String(b.cosmos ?? ""), evm = String(b.evm ?? "");
  if (!/^qor1[0-9a-z]{38}$/.test(cosmos) || !/^0x[0-9a-fA-F]{40}$/.test(evm)) return bad(c, "cosmos (qor1...) and evm (0x...) addresses of the same key");
  const day = new Date().toISOString().slice(0, 10);
  if (fundedToday.day !== day) fundedToday = { day, n: 0 };
  if (fundedToday.n >= FUND.perDay) return bad(c, "the relayer's daily budget is used up; try again tomorrow", 429);
  const now = Date.now();
  for (const k of [ip(c), cosmos, evm.toLowerCase()]) if ((funded.get(k) ?? 0) > now - 86_400_000) return bad(c, "already funded in the last 24 hours", 429);
  // The same key: the qor1 form and the 0x form are the same 20 bytes.
  const { bech32ToHex } = await import("@qorechain/sdk");
  if (bech32ToHex(cosmos).toLowerCase() !== evm.toLowerCase()) return bad(c, "cosmos and evm addresses differ");
  for (const k of [ip(c), cosmos, evm.toLowerCase()]) funded.set(k, now);
  fundedToday.n++;
  try {
    // Same operator account as the settler: share the loop's queue so sequence numbers never collide.
    const r = await loop.serial(() => send(op, "hybrid", [
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: op.cosmos, toAddress: cosmos, amount: [
        { denom: denom("fETH"), amount: FUND.publicFETH }, { denom: denom("fUSD"), amount: FUND.publicFUSD }, { denom: "uqor", amount: FUND.uqor },
      ].sort((x, y) => x.denom.localeCompare(y.denom)) } },
      { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fUSD"), amount: FUND.fUSD }, receiver: evm, sender: op.cosmos } },
      { typeUrl: CONVERT_COIN, value: { coin: { denom: denom("fETH"), amount: FUND.fETH }, receiver: evm, sender: op.cosmos } },
    ], `relayer: fund burner ${cosmos}`, "1400000"));
    return c.json({ hash: r.hash, height: r.height, sent: FUND });
  } catch (e: any) {
    for (const k of [ip(c), cosmos, evm.toLowerCase()]) funded.delete(k);
    fundedToday.n--;
    return bad(c, `relayer send failed: ${String(e.message).slice(0, 200)}`, 502);
  }
});

// ------------------------------------------------------------------ chain proxy (the REST API sends no CORS headers)
// Read-only pass-through so the SDK can run in the browser with rest = `${origin}/api/rest`.
app.get("/api/rest/*", async (c) => {
  const path = c.req.path.slice("/api/rest".length);
  if (!/^\/(cosmos|qorechain)\//.test(path)) return bad(c, "only /cosmos and /qorechain reads", 403);
  const url = new URL(c.req.url);
  const r = await fetch(`${NET.rest}${path}${url.search}`);
  // A transaction that has not landed yet is "pending", not an error.
  if (r.status === 404 && path.startsWith("/cosmos/tx/v1beta1/txs/")) return c.json({ pending: true });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
});

app.get("/api/cosmos/account/:addr", async (c) => {
  const r = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${c.req.param("addr")}`);
  if (r.status === 404) return bad(c, "account not on chain yet", 404);
  const a = ((await r.json()) as any).account;
  const base = a?.base_account ?? a ?? {};
  return c.json({ accountNumber: base.account_number ?? "0", sequence: base.sequence ?? "0" });
});
app.get("/api/cosmos/pqc/:addr", async (c) => c.json(await fetchPqcStatus({ rest: NET.rest, address: c.req.param("addr") })));
app.get("/api/cosmos/window/:addr", async (c) => c.json(await evmWindowStatus({ rest: NET.rest, address: c.req.param("addr") })));
app.get("/api/cosmos/tx/:hash", async (c) => {
  const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs/${c.req.param("hash")}`);
  if (!r.ok) return c.json({ found: false });
  const t = ((await r.json()) as any).tx_response;
  return c.json({ found: true, code: t.code, height: Number(t.height), log: t.raw_log });
});
app.post("/api/cosmos/broadcast", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.tx_bytes !== "string" || b.tx_bytes.length > 60_000) return bad(c, "tx_bytes (base64) required");
  const refused = await relayCheck(b.tx_bytes).catch((e) => `could not check the signature: ${String(e.message).slice(0, 100)}`);
  if (refused) return bad(c, `the relayer will not broadcast this: ${refused}`, 422);
  const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_bytes: b.tx_bytes, mode: "BROADCAST_MODE_SYNC" }) });
  const j = ((await r.json()) as any).tx_response ?? {};
  return c.json({ hash: j.txhash, code: j.code ?? -1, log: j.raw_log });
});
app.get("/api/me/:evm", async (c) => {
  const who = c.req.param("evm") as Hex;
  const [usd, eth, aUsd, aEth] = await Promise.all([
    pub.readContract({ address: TOKENS.fUSD.address, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }),
    pub.readContract({ address: TOKENS.fETH.address, abi: ERC20_ABI, functionName: "balanceOf", args: [who] }),
    pub.readContract({ address: TOKENS.fUSD.address, abi: ERC20_ABI, functionName: "allowance", args: [who, settlement] }),
    pub.readContract({ address: TOKENS.fETH.address, abi: ERC20_ABI, functionName: "allowance", args: [who, settlement] }),
  ]);
  return c.json({ fUSD: String(usd), fETH: String(eth), approved: { fUSD: (aUsd as bigint) > 0n, fETH: (aEth as bigint) > 0n } });
});

app.get("/api/health", async (c) => {
  const b = (await (await fetch(`${NET.rest}/cosmos/bank/v1beta1/balances/${op.cosmos}`)).json()) as any;
  return c.json({ ok: true, phase: loop.phase, relayer: b.balances, fundedToday: fundedToday.n });
});

// ------------------------------------------------------------------ the web app
if (existsSync("web/dist/index.html")) {
  app.use("/assets/*", serveStatic({ root: "web/dist" }));
  app.use("/*", serveStatic({ root: "web/dist" }));
  app.get("*", (c) => c.html(readFileSync("web/dist/index.html", "utf8")));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`blind server on :${port}, contract ${settlement}`);
