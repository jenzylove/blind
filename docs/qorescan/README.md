# Blind's cryptography, inventoried with QoreScan

[`cbom.json`](cbom.json) is a CycloneDX 1.6 cryptography bill of materials. It was made on 22 Nov 2026 with QoreScan 0.1.0, QoreChain's inventory tool:

`@qorechain/qorescan` is a dev dependency; `npm run cbom` runs the same scan:

```sh
npx qorescan scan --network testnet \
  --address qor1ugpasg28ytchzqdts4jgajgqhwglh6y3xtuw8t --address qor1nzm5ym498uv26n7vzx6j5wudqzxqyvywx85ay2 \
  --address qor1j4mrfz0l2mf6cmduxngm70rjejm5slj2xvrvkd --address qor14hhptmgaf3q8wpkxs2t7q9xlyp548wvk5wjea3 \
  --tls blind.jdollar.site:443 --solidity contracts --out docs/qorescan/cbom.json
```

It covers the operator, the market maker agent, the hedger and the public-swap bot accounts, the live site's TLS, and `contracts/`. QoreScan says the inventory is an aid, not a certification.

## What is post-quantum, and what is not

| Where | What QoreScan found | Post-quantum? |
|---|---|---|
| Every Blind account (operator, agent, hedger, bot) | An ML-DSA-87 public key registered on chain (NIST level 5), next to a secp256k1 key. Every transaction carries both signatures. | Yes. A forged secp256k1 signature alone moves nothing. |
| Orders and the agent's quote | ML-DSA-87 signatures, checked in the contract through `pqcVerify` (`0x0A01`) against the key `pqcKeyStatus` (`0x0A02`) reports | Yes |
| The agent's linked key | Ed25519 | No. A quantum attacker who forged it could only call `commit`, and every curve still needs the agent's ML-DSA-87 signature, which the contract checks. |
| The website's TLS (`blind.jdollar.site`) | TLS 1.3 with X25519 and ECDSA certificates, set by the hosting provider | No. It protects only the page download. Orders are signed with ML-DSA-87 in the browser, and only their fingerprint goes on chain until the price is locked. |
| Validator consensus keys | Ed25519 | No. This is the chain itself, outside Blind's control. |
| Contract hashing | Keccak-256 | Hashes are not broken by Shor's algorithm. |
