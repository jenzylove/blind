# Blind

Trade on QoreChain without bots seeing your order first.

Built for Build Before Q-Day, the QoreChain Developer Fest (Post-Quantum AI Agents).

**Try it:** https://blind.jdollar.site. You don't need a wallet. One button makes a test account in your browser, then you place a sealed swap and watch the batch settle, usually in under two minutes.

| | |
|---|---|
| Settlement contract (v3) | [`0xb9a36d4d4fd341b0432bbbfa99a23fcc555a836e`](https://explore.qore.network/address/0xb9a36d4d4fd341b0432bbbfa99a23fcc555a836e) on `qorechain-diana` (on the explorer, switch to Testnet at the top right) |
| Every batch, misses included | https://blind.jdollar.site/proof |
| The agent's on-chain spending rule, read live | https://blind.jdollar.site/proof and `/api/agent` |
| QCAI audit and our answer to each finding | [docs/audit/QCAI.md](docs/audit/QCAI.md) |
| Spikes, build log, AI usage | [docs/spikes](docs/spikes), [docs/BUILD_LOG.md](docs/BUILD_LOG.md), [AI_USAGE.md](AI_USAGE.md) |

## How a batch works

1. **Seal.** Your browser signs the order with your ML-DSA-87 key (registered on QoreChain), under QoreChain's message domain (`qorechain-msg-v1|qorechain-diana|`), the same bytes a QoreX wallet signs, and seals it with ML-KEM-1024 to this batch's public key. The plain order never leaves the browser.
2. **Post.** The sealed envelope goes on chain. Anyone can see that an order exists, but not its side, size or limit. Every envelope is the same size.
3. **Commit.** The market maker agent prices from public data only: the x/amm pool, its inventory and outside volatility. It signs a quote curve with its ML-DSA-87 key and commits it on chain. This closes intake.
4. **Reveal.** In a later block, never the same one, the batch key is revealed. The contract checks it against the fingerprint fixed when the batch was created. Anyone can now open every envelope from chain data.
5. **Settle.** One transaction:
   - The contract checks every user's post-quantum signature.
   - It computes one clearing price from the committed curve. The operator supplies no price.
   - It enforces each user's signed minimum and moves every leg at once.
   - The agent then hedges its net on x/amm from a separate account.

When buyers and sellers meet in a batch, they trade with each other at one price, and both do better than a plain x/amm swap. Trading alone costs about what x/amm charges plus 0.15%. Every fill is shown next to the x/amm equivalent, misses included.

## The agent's leash

The market maker agent doesn't hold the operator's key. It commits its price curve with its own ed25519 key, which is linked to the operator account with a spending rule that QoreChain enforces:

- **Allowed calls:** the only call it may make is `commit` on BlindSettlement (`allowed_evm_calls` = `0xb9a3…836e/0x6225710f`).
- **Value:** at most 1 uqor per transaction and 1 uqor a day.
- **Expiry:** the key expires after 29 days.
- **Signature:** each curve must also carry the agent's ML-DSA-87 signature, which the contract checks.

Anything else is refused by the chain itself, with its reason in an `abstractaccount_execution_failed` event. Posting, revealing and settling stay with the operator's scoped EVM window (300 transactions, 3,000 blocks, target = BlindSettlement only). They stay there because calls through the agent lane emit no EVM logs, and every order and fill must remain a public event. See [docs/spikes/agent-linked-key.md](docs/spikes/agent-linked-key.md).

## Who can read what

| | Bots and other users | The market maker agent | The operator | Everyone after the reveal |
|---|---|---|---|---|
| A swap order, before the reveal | no | not by protocol (see limits) | yes: it holds the batch key | yes |
| A limit order | no | not by protocol | yes: sealed to its standing key | when filled |
| The agent's price curve | yes, on chain before the reveal | yes | yes | yes |
| The clearing price | computed by the contract | the same | cannot choose it | yes |

## What the chain checks, and what it doesn't

The chain proves several things:
- The curve was signed and locked before the batch key was revealed.
- The revealed key is the one promised.
- Every order carries its owner's post-quantum signature.
- The contract computed the price.
- No one was filled below their signed minimum.

You trust the operator for the rest:
- It holds the batch key, so it could read orders early.
- Today the operator and the market maker run as one service. So the promise that the market maker can't price against your order rests on the operator not peeking.
- It chooses which posted orders go to settlement. Orders it leaves out are recorded with the reason.
- These are testnet tokens with no value.

## Accounts

| Role | Address |
|---|---|
| Operator: settler and relayer (`OPERATOR`) | `qor1ugpasg28ytchzqdts4jgajgqhwglh6y3xtuw8t` (`0xe203D8214722f17101ab85648ec900bb91fbe891`) |
| Market maker agent, ML-DSA-87 quote key (`AGENT`) | `qor1nzm5ym498uv26n7vzx6j5wudqzxqyvywx85ay2` (`0x98b7426ea53F18Ad4FcC11B52a3B8d008C02308e`) |
| Agent's linked ed25519 key on the operator account | `0xd6c12f40051980dcc8f1c0c2fe110c29a6a67c88c66c209ca99be3d3f9fe938c` |
| Hedger and treasury (`HEDGER`) | `qor1j4mrfz0l2mf6cmduxngm70rjejm5slj2xvrvkd` (`0x95763489fF56D3ac6dBc34d1BF3c72ccb7487E4A`) |
| Previous contracts | v2 (curve, orders signed without QoreChain's message domain) `0xbdbd8fa8247a9bbc598f72cb46a2c7e3194ef3cf`; v1 (flat band, the first miss) `0x4906cbdec09a89bd71aeccaf6e0b450c5a9cecc1` |

## Run it

You need Node 22+ and Foundry.

```sh
git clone --recurse-submodules https://github.com/jenzylove/blind && cd blind
npm install && npm --prefix web install
forge test                                  # 35 contract tests
npx tsx --test test/*.test.ts               # 11 agent policy tests
cp .env.example .env                        # testnet keys only
npm --prefix web run build
npx tsx server/index.ts                     # http://localhost:8787 (only one server may hold the operator key)
BLIND_ENV=.env npx tsx scripts/link-agent.ts status   # the agent's linked key and its rule
```

## Q-Day Drill

`DrillVault` is Blind's settlement core, deployed on `qorechain-diana` for the Q-Day Drill.

| | Address |
|---|---|
| Drill account | `qor12xlna2e4qdpqumgvmfdq62lqmppshrwha4sjva` (`0x51BF3eab3503420e6d0CDa5a0D2bE0D8430b8dD7`) |
| DrillVault | `0x150babdc7e487ea5f46c0c3236dea4c0e0b79053` (`qor1z596hhr7fpl2tarvpserdh4ycrst0yzn0mjhlp`) |

The vault holds 50 test QOR. Money leaves only with an ML-DSA-87 signature from the owner's registered key, checked on chain by `pqcVerify` at `0x0A01`. Possession of that key is proven through `pqcKeyStatus` at `0x0A02`.

## Built with

- [QoreChain](https://qorechain.io) testnet, `@qorechain/sdk` (accounts, hybrid signing, authenticators and spending rules), `@qorechain/evm` (EVM windows) and `@qorechain/qoreseal` (ML-KEM-1024 sealing).
- [viem](https://viem.sh), [Hono](https://hono.dev), [tsx](https://tsx.is) and `@noble/curves` on the server.
- [React](https://react.dev), [Vite](https://vite.dev) and [three.js](https://threejs.org) for the web app. Fonts: Archivo and Fragment Mono (Google Fonts, OFL).
- [Foundry](https://getfoundry.sh) and forge-std for contract tests.
- Built with Claude Code. See [AI_USAGE.md](AI_USAGE.md).

## Licence

MIT
