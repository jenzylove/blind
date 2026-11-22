// Before relaying a browser's transaction, check its hybrid signature with QoreSign, the way a custodian
// checks before broadcast: the secp256k1 half, and the ML-DSA-87 half against the key the account has
// registered on chain. Only the key registration itself may be classical (there is no ML-DSA key yet).
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { verifyHybridTx } from "@qorechain/qoresign";
import { evmToQor, fetchPqcStatus, pqcStatusPublicKey } from "@qorechain/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { NET } from "../src/chain.ts";

/** Null when the transaction may be relayed; otherwise the reason it may not. */
export async function relayCheck(txB64: string): Promise<string | null> {
  const raw = new Uint8Array(Buffer.from(txB64, "base64"));
  const tx = decodeTxRaw(raw);
  if (tx.authInfo.signerInfos.length !== 1) return "one signer expected";
  const pkAny = tx.authInfo.signerInfos[0].publicKey;
  const key = pkAny && pkAny.value.length === 35 ? pkAny.value.slice(2) : null; // proto { bytes key = 1 }, 33-byte key
  if (!key) return "unexpected public key";
  const uncompressed = secp256k1.Point.fromBytes(key).toBytes(false);
  const addr = evmToQor("0x" + Buffer.from(keccak_256(uncompressed.slice(1)).slice(12)).toString("hex"));
  const acct = (await (await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${addr}`)).json()) as any;
  const base = acct.account?.base_account ?? acct.account;
  if (!base?.account_number) return "unknown account";
  const pq = pqcStatusPublicKey(await fetchPqcStatus({ rest: NET.rest, address: addr }));
  const onlyRegister = tx.body.messages.every((m) => /MsgRegisterPQCKey/.test(m.typeUrl));
  if (!pq && !onlyRegister) return "this account has no ML-DSA-87 key registered yet";
  const r = verifyHybridTx({ txBytes: raw, chainId: NET.chainId, accountNumber: BigInt(base.account_number), classicalPublicKey: key,
    classicalKeyType: "eth_secp256k1", pqPublicKey: pq ?? undefined, signBytesVersion: "either" });
  if (!r.valid) return `signature check failed (classical ${r.classical}, ML-DSA-87 ${r.pq ? JSON.stringify(r.pq).slice(0, 80) : "not checked"})`;
  return null;
}
