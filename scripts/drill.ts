// Q-Day Drill setup for the DRILL account (testnet only).
//   npx tsx drill.ts status | register | deploy | fund <qor> | selfsend
// deploy = open a short window, deploy DrillVault, close the window at once.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import solc from "solc";
import { StargateClient } from "@cosmjs/stargate";
import { createPublicClient, createWalletClient, http, defineChain, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchPqcStatus,
  openEvmWindowMsg, closeEvmWindowMsg, signProofOfPossession, type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowStatus } from "@qorechain/evm";

const NET = { chainId: "qorechain-diana", rest: "https://api-testnet.qore.host", rpc: "https://rpc-testnet.qore.host", evm: "https://evm-testnet.qore.host" };
const chain = defineChain({ id: 9800, name: "qorechain-diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 }, rpcUrls: { default: { http: [NET.evm] } } });
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) env[m[1]] = m[2];
}
const acc: UnifiedAccount = await deriveUnifiedAccount(env.DRILL_MNEMONIC, 0);
const pub = createPublicClient({ chain, transport: http() });

async function seq() {
  const r = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  if (!r.ok) throw new Error(`account query HTTP ${r.status}`);
  const b = (await r.json()) as any;
  const a = b.account?.base_account ?? b.account ?? {};
  return { accountNumber: BigInt(a.account_number ?? "0"), sequence: BigInt(a.sequence ?? "0") };
}

async function broadcast(mode: "hybrid" | "classical", messages: any[]) {
  const { accountNumber, sequence } = await seq();
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: NET.rest });
  const t = await StargateClient.connect(NET.rpc);
  try {
    const res = await signer.signAndBroadcast(t, { chainId: NET.chainId, accountNumber, sequence, fee: FEE, messages });
    return res.transactionHash as string;
  } finally { t.disconnect(); }
}

async function waitTx(hash: string) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${NET.rest}/cosmos/tx/v1beta1/txs/${hash}`);
    if (r.ok) { const b = (await r.json()) as any; return b.tx_response?.code ?? 0; }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw new Error(`tx ${hash} not committed`);
}

async function status() {
  const bal = (await (await fetch(`${NET.rest}/cosmos/bank/v1beta1/balances/${acc.cosmos}/by_denom?denom=uqor`)).json()) as any;
  const pqc = await fetchPqcStatus({ rest: NET.rest, address: acc.cosmos });
  const w = await evmWindowStatus({ rest: NET.rest, address: acc.cosmos });
  console.log(`account ${acc.cosmos} ${acc.evm}`);
  console.log(`balance ${Number(bal?.balance?.amount ?? 0) / 1e6} QOR | pqc registered ${pqc.registered} | window ${w.found ? (w.live ? "LIVE" : "not usable") : "none"}`);
  if (existsSync("vault.json")) {
    const v = JSON.parse(readFileSync("vault.json", "utf8"));
    console.log(`vault ${v.address} holds ${Number(await pub.getBalance({ address: v.address })) / 1e18} QOR`);
  }
}

async function register() {
  const pqc = await fetchPqcStatus({ rest: NET.rest, address: acc.cosmos });
  if (pqc.registered) return console.log("already registered");
  const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  const h = await broadcast("classical", [msg]);
  console.log(`register ${h} code ${await waitTx(h)}`);
}

function compile() {
  const input = { language: "Solidity", sources: { "DrillVault.sol": { content: readFileSync("contracts/DrillVault.sol", "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e: any) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e: any) => e.formattedMessage).join("\n"));
  const c = out.contracts["DrillVault.sol"].DrillVault;
  return { abi: c.abi, bytecode: ("0x" + c.evm.bytecode.object) as `0x${string}` };
}

async function deploy() {
  const { abi, bytecode } = compile();
  const o = await broadcast("hybrid", [openEvmWindowMsg({ sender: acc.cosmos, blocks: 120n, maxTxs: 2n, maxValue: 2_000_000_000n })]);
  console.log(`window open ${o} code ${await waitTx(o)}`);
  await new Promise((ok) => setTimeout(ok, 6000));
  const wallet = createWalletClient({ account: privateKeyToAccount(acc.privateKey as `0x${string}`), chain, transport: http() });
  try {
    const hash = await wallet.deployContract({ abi, bytecode, args: [acc.evm] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`deployed ${rc.contractAddress} tx ${hash} status ${rc.status}`);
    writeFileSync("vault.json", JSON.stringify({ address: rc.contractAddress, tx: hash, abi }, null, 2));
  } finally {
    await new Promise((ok) => setTimeout(ok, 3000));
    const c = await broadcast("hybrid", [closeEvmWindowMsg(acc.cosmos)]);
    console.log(`window closed ${c} code ${await waitTx(c)}`);
  }
}

async function fund(qor: string) {
  const v = JSON.parse(readFileSync("vault.json", "utf8"));
  const o = await broadcast("hybrid", [openEvmWindowMsg({ sender: acc.cosmos, blocks: 60n, maxTxs: 1n, maxValue: BigInt(Math.round(Number(qor) * 1e6)) + 500_000_000n })]);
  console.log(`window open ${o} code ${await waitTx(o)}`);
  await new Promise((ok) => setTimeout(ok, 6000));
  const wallet = createWalletClient({ account: privateKeyToAccount(acc.privateKey as `0x${string}`), chain, transport: http() });
  try {
    const hash = await wallet.sendTransaction({ to: v.address, value: parseEther(qor) });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`funded vault with ${qor} QOR tx ${hash} status ${rc.status}`);
  } finally {
    await new Promise((ok) => setTimeout(ok, 3000));
    const c = await broadcast("hybrid", [closeEvmWindowMsg(acc.cosmos)]);
    console.log(`window closed ${c} code ${await waitTx(c)}`);
  }
}

async function selfsend() {
  const h = await broadcast("hybrid", [{ typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { fromAddress: acc.cosmos, toAddress: acc.cosmos, amount: [{ denom: "uqor", amount: "1" }] } }]);
  console.log(`normal transaction ${h} code ${await waitTx(h)}`);
}

const cmd = process.argv[2] ?? "status";
const run: Record<string, () => Promise<unknown>> = { status, register, deploy, fund: () => fund(process.argv[3] ?? "50"), selfsend };
await (run[cmd] ?? status)();
