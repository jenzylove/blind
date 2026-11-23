// Check Blind's live deployment from public chain data alone. No keys, no server access beyond the public
// attack log. Prints PASS / FAIL per check and exits 1 on any FAIL.
//   npm run verify
//   VERIFY_BATCHES=5               how many of the newest settled batches to replay (default 5)
//   VERIFY_ATTACKS=<url or file>   attack log to check (default https://blind.jdollar.site/api/attacks)
import { existsSync, readFileSync } from "node:fs";
import {
  createPublicClient, http, encodeAbiParameters, keccak256, hexToString, decodeFunctionData, parseAbi, toFunctionSelector,
  type Hex, type Abi,
} from "viem";
import { chain, NET } from "../src/chain.ts";

const dep = JSON.parse(readFileSync("deployments/testnet.json", "utf8"));
const abi = JSON.parse(readFileSync("web/src/abi.json", "utf8")) as Abi;
const C = dep.settlement as Hex;
const N = Number(process.env.VERIFY_BATCHES ?? 5);
const ATTACKS = process.env.VERIFY_ATTACKS ?? "https://blind.jdollar.site/api/attacks";
const pub = createPublicClient({ chain, transport: http(NET.evm, { retryCount: 5, retryDelay: 800, timeout: 30_000 }) });

// ------------------------------------------------------------------ output
let fails = 0, passes = 0, skips = 0;
const pass = (s: string) => { passes++; console.log(`PASS  ${s}`); };
const fail = (s: string) => { fails++; console.log(`FAIL  ${s}`); };
const skip = (s: string) => { skips++; console.log(`SKIP  ${s}`); };
const check = (ok: boolean, s: string, why = "") => (ok ? pass(s) : fail(why ? `${s}: ${why}` : s));
const eq = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** RPC and REST hiccup on a public testnet: retry with backoff before calling anything a failure. */
async function retry<T>(f: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await f(); } catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 700 * 2 ** i)); }
  }
  throw last;
}
const rest = (path: string) => retry(async () => {
  const r = await fetch(`${NET.rest}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<any>;
});
const read = <T>(functionName: string, args: any[] = []) => retry(() => pub.readContract({ address: C, abi, functionName, args }) as Promise<T>);
const section = (s: string) => console.log(`\n# ${s}`);

// ------------------------------------------------------------------ 1. the contract
section(`contract v${dep.version} at ${C}`);
const code = await retry(() => pub.getCode({ address: C }));
check(!!code && code.length > 2, "contract code exists", "no code at the address");

const [agent, maker, owner, settler, treasury, domain, revealWindow] = await Promise.all([
  read<Hex>("agent"), read<Hex>("maker"), read<Hex>("owner"), read<Hex>("settler"), read<Hex>("treasury"), read<Hex>("msgDomain"), read<bigint>("revealWindow"),
]);
check(eq(agent, dep.agent), "agent matches deployments/testnet.json", `${agent} vs ${dep.agent}`);
check(eq(maker, dep.maker), "maker matches deployments/testnet.json", `${maker} vs ${dep.maker}`);
check(eq(owner, dep.owner), "owner matches deployments/testnet.json", `${owner} vs ${dep.owner}`);
check(eq(settler, dep.settler), "settler matches deployments/testnet.json", `${settler} vs ${dep.settler}`);
check(eq(treasury, dep.treasury), "treasury matches deployments/testnet.json", `${treasury} vs ${dep.treasury}`);
check(hexToString(domain) === dep.msgDomain, `message domain is "${dep.msgDomain}"`, hexToString(domain));
check(Number(revealWindow) === Number(dep.revealBlocks), `reveal window is ${dep.revealBlocks} blocks`, String(revealWindow));

// ------------------------------------------------------------------ 2. the owner's mandate
section("the owner's mandate");
const head = await retry(() => pub.getBlockNumber());
const m = await read<any[]>("mandate");
check(BigInt(m[0]) > 0n, `mandate is set (max net ${m[0]} base units per batch)`, "maxNet is 0");
check(BigInt(m[6]) > head, `mandate has not expired (expires at block ${m[6]}, head ${head})`, "expired");
if (dep.mandate) {
  const same = eq(m[0], dep.mandate.maxNet) && eq(m[1], dep.mandate.maxSpreadBps) && eq(m[2], dep.mandate.bandBps) && eq(m[6], dep.mandate.expiry);
  check(same, "mandate on chain matches deployments/testnet.json", JSON.stringify(m.map(String)));
}

// ------------------------------------------------------------------ 3. the agent's leash
section("the agent's linked key on the maker account");
const commitSel = toFunctionSelector((abi as any[]).find((f) => f.type === "function" && f.name === "commit"));
const rules = await rest(`/qorechain/abstractaccount/v1/accounts/${dep.makerCosmos}/spending_rules`);
const enabled = (rules.rules ?? []).filter((r: any) => r.enabled);
const calls = enabled.flatMap((r: any) => r.allowed_evm_calls ?? []);
check(enabled.length > 0, "the maker account has an enabled spending rule", "none");
check(calls.length > 0 && calls.every((x: string) => eq(x, `${C}/${commitSel}`)), `the rule allows only commit (${commitSel}) on v${dep.version}`, JSON.stringify(calls));
check(enabled.every((r: any) => BigInt(r.per_tx_limit ?? 0) <= 1n && BigInt(r.daily_limit ?? 0) <= 1n), "the rule moves at most 1 uqor per call and per day", JSON.stringify(enabled.map((r: any) => [r.per_tx_limit, r.daily_limit])));
const auths = (await rest(`/qorechain/abstractaccount/v1/accounts/${dep.makerCosmos}/authenticators`)).authenticators ?? [];
const key = auths.find((a: any) => eq(a.pubkey_hex, dep.agentKey));
check(!!key, `the agent's key ${String(dep.agentKey).slice(0, 12)}… is linked`, "not found");
if (key) {
  check(!key.revoked, "the agent's key is not revoked");
  check(Number(key.expiry_unix) * 1000 > Date.now(), `the agent's key has not expired (until ${new Date(Number(key.expiry_unix) * 1000).toISOString().slice(0, 10)})`, "expired");
}
const others = auths.filter((a: any) => !a.revoked && !eq(a.pubkey_hex, dep.agentKey));
check(others.length === 0, "no other live key is linked to the maker account", JSON.stringify(others.map((a: any) => a.pubkey_hex)));

// ------------------------------------------------------------------ 4. ML-DSA-87 keys
section("ML-DSA-87 keys (pqcKeyStatus 0x0A02)");
const STATUS = parseAbi(["function pqcKeyStatus(address) view returns (bool registered, uint8 alg, bytes key, bool proven)"]);
for (const [who, addr] of [["owner", owner], ["agent", agent], ["maker", maker]] as const) {
  const [registered, alg, k, proven] = await retry(() => pub.readContract({ address: "0x0000000000000000000000000000000000000a02", abi: STATUS, functionName: "pqcKeyStatus", args: [addr] }));
  check(registered && alg === 1 && proven && (k.length - 2) / 2 === 2592, `${who} has a registered, proven ML-DSA-87 key`, `registered ${registered} alg ${alg} proven ${proven} key ${(k.length - 2) / 2} bytes`);
}

// ------------------------------------------------------------------ 5. settled batches, replayed from events
section(`the newest ${N} settled batches, replayed from chain events`);
const ORDER = { type: "tuple", components: [
  { name: "user", type: "address" }, { name: "batch", type: "uint64" }, { name: "expiry", type: "uint64" },
  { name: "buy", type: "bool" }, { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "nonce", type: "uint256" },
] } as const;
const orderHash = (o: any) => keccak256(encodeAbiParameters([ORDER], [o]));
const count = Number(await read<bigint>("batchCount"));
let replayed = 0;
for (let id = count; id >= 1 && replayed < N; id--) {
  const b = await read<any[]>("batches", [BigInt(id)]);
  const [openBlock, commitBlock, settleBlock] = [Number(b[0]), Number(b[1]), Number(b[2])];
  if (!settleBlock) continue;
  replayed++;
  const ev = (eventName: string) => retry(() => pub.getContractEvents({ address: C, abi, eventName, args: { batch: BigInt(id) }, fromBlock: BigInt(openBlock), toBlock: BigInt(settleBlock) })) as Promise<any[]>;
  const [posted, revealed, settled, filled, committed] = await Promise.all([ev("Posted"), ev("Revealed"), ev("Settled"), ev("Filled"), ev("Committed")]);
  const tag = `batch ${id}`;
  // The commit goes through the agent's linked key, a lane that emits no EVM logs; its block is in storage.
  check(commitBlock > openBlock, `${tag}: price locked (block ${commitBlock}) after the batch opened (block ${openBlock})`);
  if (committed.length) check(Number(committed[0].blockNumber) === commitBlock, `${tag}: Committed event in the stored commit block`);
  check(posted.every((p) => Number(p.blockNumber) <= commitBlock), `${tag}: all ${posted.length} fingerprints posted before the price was locked`);
  check(revealed.every((r) => Number(r.blockNumber) > commitBlock), `${tag}: all ${revealed.length} reveals in blocks strictly after the commit`,
    revealed.filter((r) => Number(r.blockNumber) <= commitBlock).map((r) => r.transactionHash).join(" "));
  // Every reveal recomputes to the fingerprint posted at its index (the salt comes from the reveal's calldata).
  let match = 0;
  const bad: string[] = [];
  for (const r of revealed) {
    const tx = await retry(() => pub.getTransaction({ hash: r.transactionHash }));
    let salt: Hex | null = null;
    try {
      const d = decodeFunctionData({ abi, data: tx.input });
      if (d.functionName === "reveal") salt = (d.args as any[])[4];
    } catch { /* not a direct reveal call */ }
    const fp = posted.find((p) => p.args.index === r.args.index)?.args.fingerprint as Hex | undefined;
    if (!salt || !fp) { bad.push(`${r.transactionHash} (${!salt ? "salt not in calldata" : "no posted fingerprint"})`); continue; }
    const re = await read<Hex>("fingerprintOf", [r.args.order, r.args.signature, salt]);
    if (eq(re, fp)) match++; else bad.push(r.transactionHash);
  }
  check(bad.length === 0, `${tag}: ${match} of ${revealed.length} reveals recompute to their posted fingerprint (fingerprintOf)`, bad.join(" "));
  const allIn = revealed.length >= posted.length;
  check(settled.length === 1 && (allIn || settleBlock > commitBlock + Number(revealWindow)),
    `${tag}: settled in block ${settleBlock}, ${allIn ? "after every order was revealed" : "after the reveal window ended"}`,
    settled.length !== 1 ? `${settled.length} Settled events` : `settled at ${settleBlock} with ${revealed.length}/${posted.length} revealed before ${commitBlock + Number(revealWindow)}`);
  const revealedHashes = new Map(revealed.map((r) => [orderHash(r.args.order).toLowerCase(), String(r.args.order.user).toLowerCase()]));
  const orphan = filled.filter((f) => revealedHashes.get(String(f.args.orderHash).toLowerCase()) !== String(f.args.user).toLowerCase());
  check(orphan.length === 0, `${tag}: all ${filled.length} fills belong to a revealed order of the same user`, orphan.map((f) => f.args.user).join(" "));
}
if (!replayed) skip("no settled batch on this contract yet");

// ------------------------------------------------------------------ 6. the attack log
section(`the public attack log (${ATTACKS})`);
let log: any = null;
try {
  if (/^https?:/.test(ATTACKS)) {
    const r = await retry(() => fetch(ATTACKS));
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) log = await r.json();
  } else if (existsSync(ATTACKS)) log = JSON.parse(readFileSync(ATTACKS, "utf8"));
} catch { /* reported below */ }
if (!log) skip("the attack log is not published at this address yet");
else {
  check(log.totals?.succeeded === 0, `${log.totals?.tried ?? 0} attempts, ${log.totals?.refused ?? 0} refused, ${log.totals?.succeeded} got through`, "an attack succeeded");
  const recent = (log.log ?? []).filter((x: any) => x.txHash && !x.dryRun).slice(0, 25);
  for (const a of recent) {
    const h = String(a.txHash);
    try {
      if (h.startsWith("0x")) {
        const rc = await retry(() => pub.getTransactionReceipt({ hash: h as Hex }));
        check(rc.status === "reverted", `${a.name}: tx ${h.slice(0, 12)}… reverted on chain in block ${rc.blockNumber}`, `status ${rc.status}`);
      } else {
        const t = (await rest(`/cosmos/tx/v1beta1/txs/${h}`)).tx_response;
        const refused = t.code !== 0 || (t.events ?? []).some((e: any) => e.type === "abstractaccount_execution_failed");
        check(refused, `${a.name}: tx ${h.slice(0, 12)}… refused by the chain in block ${t.height}`, "no refusal on chain");
      }
    } catch (e: any) { fail(`${a.name}: tx ${h} not found on chain (${String(e.message).slice(0, 80)})`); }
  }
}

console.log(`\n${passes} passed, ${fails} failed${skips ? `, ${skips} skipped` : ""}`);
process.exit(fails ? 1 : 0);
