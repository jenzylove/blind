// Which QoreChain technology does each piece of Blind's work. Every line here is true of the live build.
export const REPO = "https://github.com/jenzylove/blind";
export const CONTRACT = "0x036701960d6e42e6d167222a917405ba3315a79b";
export const CONTRACT_URL = `https://explore.qore.network/address/${CONTRACT}`;
export const RELAY_SRC = `${REPO}/blob/main/server/relay.ts`;
export const LIMIT_SRC = `${REPO}/blob/main/server/loop.ts`;
export const QORESCAN_URL = `${REPO}/tree/main/docs/qorescan`;
export const QCAI_URL = `${REPO}/blob/main/docs/audit/QCAI.md`;
export const AGENT_SPIKE = `${REPO}/blob/main/docs/spikes/agent-linked-key.md`;
export const txUrl = (h: string) => `/api/explorer/tx/${h}`;

/** One quiet line per batch step: the QoreChain feature doing that step. Same order as STEPS. */
export const STEP_TECH: { name: string; rest: string }[] = [
  { name: "ML-DSA-87", rest: "your order signed in this browser; only its 32 byte fingerprint leaves it" },
  { name: "QoreChain EVM", rest: "the fingerprint posted to BlindSettlement from the operator's scoped EVM window" },
  { name: "Account abstraction", rest: "curve signed with ML-DSA-87, committed by the agent's linked key under a spending rule, inside the owner's mandate" },
  { name: "BlindSettlement", rest: "your browser reveals the order after the commit; the contract checks it against its fingerprint" },
  { name: "pqcVerify 0x0A01", rest: "checks every order signature against the key pqcKeyStatus 0x0A02 reports" },
];

/** Price commits made through the agent's linked key are Cosmos transactions (MsgExecuteEVM); older ones were plain EVM calls. */
export const viaLinkedKey = (hash?: string) => !!hash && !hash.startsWith("0x");
export const COMMIT_PLAIN = { name: "pqcVerify 0x0A01", rest: "the agent's ML-DSA-87 signature on its curve, checked on chain" };

export const KITS = ["@qorechain/sdk", "@qorechain/qoreseal", "@qorechain/qoresign", "@qorechain/evm", "@qorechain/pqc"];
