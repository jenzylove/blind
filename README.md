# Blind

Trade on QoreChain without bots seeing your order first.

Built for Build Before Q-Day, the QoreChain Developer Fest (Post-Quantum dApp).

**Try it:** https://blind.jdollar.site. You don't need a wallet. One button makes a test account in your browser, then you place a swap and watch the batch settle, usually in under two minutes. A QoreX wallet works too.

| | |
|---|---|
| Settlement contract (v5) | [`0x143e9152c9a1b97668d6fbd23126e1616275aac7`](https://explore.qore.network/address/0x143e9152c9a1b97668d6fbd23126e1616275aac7) on `qorechain-diana` (on the explorer, switch to Testnet at the top right) |
| Demo video (3 min) | https://youtu.be/sAV76SPZ7qk |
| Every batch, misses included | https://blind.jdollar.site/proof |
| The market maker's spending rule and the owner's mandate, read live | https://blind.jdollar.site/proof and `/api/agent` |
| Security audits: QCAI scores 78 on the live contract (72 before the v5 fixes); every finding mapped to code and a test | [docs/AUDIT.md](docs/AUDIT.md) |
| Spikes, build log, AI usage | [docs/spikes](docs/spikes), [docs/BUILD_LOG.md](docs/BUILD_LOG.md), [AI_USAGE.md](AI_USAGE.md) |

## How a batch works

1. **Sign.** Your browser signs the order with your ML-DSA-87 key (registered on QoreChain), under QoreChain's message domain (`qorechain-msg-v1|qorechain-diana|`), the same bytes a QoreX wallet signs.
2. **Post a fingerprint.** Only `keccak256(order, keccak256(signature), salt)` goes on chain, posted by the relayer (the contract accepts posts from nobody else, so a batch cannot be flooded with junk): 32 bytes, with a random salt that never leaves your browser. Anyone can see that an order exists, but not its side, size or limit, and no key anywhere opens it. Not ours, not the market maker's.
3. **Commit.** The market maker agent prices from public data only: the x/amm pool, its inventory and outside volatility. It signs a quote curve with its ML-DSA-87 key and commits it on chain through its own leashed account (below). The contract refuses a curve outside the owner's mandate. This closes intake.
4. **Reveal.** From the next block, your browser hands over the order, salt and signature (only the order's own user or the relayer may reveal it). The contract recomputes the fingerprint and rejects anything that does not match. The browser watches the contract, not our server, and after a reload it picks up any reveal it still owes. The window is 20 blocks.
5. **Settle.** Once every order is revealed, or the window is over, one transaction:
   - checks every user's post quantum signature with `pqcVerify` (`0x0A01`) against the key `pqcKeyStatus` (`0x0A02`) reports,
   - computes one clearing price from the committed curve (the operator supplies no price),
   - enforces each user's signed minimum and moves every leg at once.

   The hedger then rebalances its net on x/amm from a separate account.

The price is fixed while every order is still a fingerprint. Nobody, us included, can trade ahead of an order it cannot read.

When buyers and sellers meet in a batch, they trade with each other at one price. The lighter side gets a much better price than a plain x/amm swap, and the heavier side pays about what the market maker charges to take the rest. Trading alone costs about what x/amm charges plus 0.15%. Every fill is shown next to the x/amm equivalent, misses included. On the same page, a public x/amm swap runs against a live sandwich bot so you can see the difference: in our runs the bot lands first about 4 times in 5 and the public swap loses about 2.8%.

## The market maker's leash

The market maker is an agent with real inventory. Two independent locks hold it.

**The chain's spending rule.** The agent signs with its own ed25519 key, linked to the market maker account (`qor1phev…7pe`). QoreChain enforces:
- **Allowed calls:** only `commit` on BlindSettlement (`allowed_evm_calls` = `0x143e…aac7/0x6225710f`).
- **Value:** at most 1 uqor per transaction and 1 uqor a day.
- **Expiry:** the key expires after 29 days.

Anything else is refused by the chain itself, with its reason in an `abstractaccount_execution_failed` event. See [docs/spikes/agent-linked-key.md](docs/spikes/agent-linked-key.md).

**The owner's mandate.** A separate owner key signs, with ML-DSA-87, the limits the contract enforces on every commit and withdrawal:
- the curve may net at most 0.05 fETH per batch, with a spread of at most 3%,
- every price on the curve stays within 15% of the last settled price over 2,000 blocks,
- at most 0.02 fETH or 100 fUSD may leave the contract per day, each withdrawal signed by the owner,
- the mandate expires.

The contract checks that the sender is the market maker, the curve is inside the mandate, and the agent's ML-DSA-87 signature is valid. A stolen agent key can commit a bad but bounded curve and nothing else. It cannot move a single token.

## Who can read what

| | Bots and other users | The market maker | The operator | Everyone after the reveal |
|---|---|---|---|---|
| A swap, before the price is locked | no | no | no: only a fingerprint is posted | yes |
| A limit order | no | no | yes: sealed to its standing key (QoreSeal, ML-KEM-1024 + X25519) | when filled |
| The market maker's curve | yes, on chain before any reveal | yes | yes | yes |
| The clearing price | computed by the contract | the same | cannot choose it | yes |

## What the chain checks, and what it doesn't

The chain proves:
- The curve was signed, inside the owner's mandate, and locked while every swap was a fingerprint.
- Every revealed order matches the fingerprint posted before the price.
- Every order carries its owner's post quantum signature.
- The contract computed the price, and no one was filled below their signed minimum.
- Settlement waits for every reveal or the end of the window.

You trust the operator for the rest:
- It relays your fingerprint and your reveal. It cannot read or change either, but it could fail to relay. An unrevealed order simply does not trade, and nothing moves.
- Limit orders wait across batches while you are offline, so we hold their key and reveal them.
- These are testnet tokens with no value.

## Try to rob it

https://blind.jdollar.site/attack has nine buttons. Each one sends a real transaction on QoreChain testnet from our attacker account, or signed with the market maker agent's real linked key, and shows who stopped it:

| Attack | Stopped by |
|---|---|
| Use the agent's key to send fUSD, withdraw, or settle | QoreChain's spending rule on the key (`abstractaccount_execution_failed`) |
| Lock a fake price from another account | the contract: `NotMaker` |
| Rewrite the owner's mandate, or pull inventory, with our own ML-DSA-87 key | `pqcVerify` (`0x0A01`): `BadSignature` |
| Settle a batch as someone else | the contract: `NotSettler` |
| Open a fingerprint with a made up order | the contract: `BadReveal` or `BadPhase` |
| Flood a batch with junk fingerprints | the contract: `NotSettler` |

Every attempt is logged publicly with its transaction at `/api/attacks`.

## Check it yourself, no keys

```sh
npm install && npm run verify
```

`npm run verify` reads only the public chain and the public site. It checks the deployed bytecode and its settings, the owner's mandate, the agent key's spending rule (commit only, at most 1 uqor), that the owner, agent and maker keys are registered ML-DSA-87 keys, replays every batch on the current contract from its events (each fill belongs to a revealed order, each reveal came after the commit), and confirms every logged attack failed on chain. CI runs it daily with the contract tests and a 5,000 run fuzz ([.github/workflows/verify.yml](.github/workflows/verify.yml)).

## Accounts

| Role | Address |
|---|---|
| Operator: settler and relayer (`OPERATOR`) | `qor1ugpasg28ytchzqdts4jgajgqhwglh6y3xtuw8t` (`0xe203D8214722f17101ab85648ec900bb91fbe891`) |
| Market maker account, commit only (`MAKER`) | `qor1phevqf9l7akmy308c5h3w3sx388tjkl4gvk7pe` (`0x0Df2c024bFF76dB245e7c52f17460689cEB95bF5`) |
| Market maker agent, ML-DSA-87 quote key (`AGENT`) | `qor1nzm5ym498uv26n7vzx6j5wudqzxqyvywx85ay2` (`0x98b7426ea53F18Ad4FcC11B52a3B8d008C02308e`) |
| Agent's linked ed25519 key on the maker account | `0xd6c12f40051980dcc8f1c0c2fe110c29a6a67c88c66c209ca99be3d3f9fe938c` |
| Owner: ML-DSA-87 mandate and withdrawals (`OWNER`) | `qor1nl3u6uq7rhnd3ddhrhu0v0hg8ktx8xnpmqy67q` (`0x9fE3Cd701e1dE6d8B5b71DF8F63eE83D96639a61`) |
| Hedger and treasury (`HEDGER`) | `qor1j4mrfz0l2mf6cmduxngm70rjejm5slj2xvrvkd` (`0x95763489fF56D3ac6dBc34d1BF3c72ccb7487E4A`) |
| Previous contracts | v4 (anyone could post a fingerprint; same design otherwise) `0x036701960d6e42e6d167222a917405ba3315a79b`; v3 (operator held a batch key) `0xb9a36d4d4fd341b0432bbbfa99a23fcc555a836e`; v2 (orders signed without QoreChain's message domain) `0xbdbd8fa8247a9bbc598f72cb46a2c7e3194ef3cf`; v1 (flat band, the first miss) `0x4906cbdec09a89bd71aeccaf6e0b450c5a9cecc1` |

## Run it

You need Node 22+ and Foundry.

```sh
git clone --recurse-submodules https://github.com/jenzylove/blind && cd blind
npm install && npm --prefix web install
forge test                                  # 54 contract tests, fuzzed
npx tsx --test test/*.test.ts               # 11 agent policy tests
cp .env.example .env                        # testnet keys only
npm --prefix web run build
npx tsx server/index.ts                     # http://localhost:8787 (only one server may hold the operator key)
BLIND_ENV=.env npx tsx scripts/setup.ts status        # the maker's linked key, its rule and the mandate
```

## Q-Day Drill

`DrillVault` is Blind's settlement core, deployed on `qorechain-diana` for the Q-Day Drill.

| | Address |
|---|---|
| Drill account | `qor12xlna2e4qdpqumgvmfdq62lqmppshrwha4sjva` (`0x51BF3eab3503420e6d0CDa5a0D2bE0D8430b8dD7`) |
| DrillVault | `0x150babdc7e487ea5f46c0c3236dea4c0e0b79053` (`qor1z596hhr7fpl2tarvpserdh4ycrst0yzn0mjhlp`) |

The vault holds 50 test QOR. Money leaves only with an ML-DSA-87 signature from the owner's registered key, checked on chain by `pqcVerify` at `0x0A01`. Possession of that key is proven through `pqcKeyStatus` at `0x0A02`.

## Built with

- [QoreChain](https://qorechain.io) testnet, `@qorechain/sdk` (accounts, hybrid signing, authenticators and spending rules), `@qorechain/evm` (EVM windows), `@qorechain/qoreseal` (ML-KEM-1024 sealing for limit orders), `@qorechain/qoresign` (relay checks) and `@qorechain/pqc`.
- [viem](https://viem.sh), [Hono](https://hono.dev), [tsx](https://tsx.is) and `@noble/curves` on the server.
- [React](https://react.dev), [Vite](https://vite.dev) and [three.js](https://threejs.org) for the web app. Fonts: Archivo and Fragment Mono (Google Fonts, OFL).
- [Foundry](https://getfoundry.sh) and forge-std for contract tests.
- Built with Claude Code. See [AI_USAGE.md](AI_USAGE.md).

## Licence

MIT
