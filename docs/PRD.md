# PRD: Blind

Build Before Q-Day, the QoreChain Developer Fest. Category: **Post-Quantum AI Agents** (1st $1,500, 2nd $750). Also entered: **Q-Day Drill** (registered 17 Nov), Best AI-Native (`AI_USAGE.md`, about AI used while building), Regional (Nigeria), Top-Quality (70/100+). Deadline **2 Dec 2026, 23:59 UTC**. Testnet `qorechain-diana` only; mainnet is not required.

Project page: build.qorechain.io (project "Blind"). Repo: https://github.com/jenzylove/blind (public, MIT).

## One line

Trade on QoreChain's built-in exchange without bots seeing your order first: orders stay sealed until an AI market maker has committed its price on chain, then every order in the batch fills at one fair price, and the chain, not the AI, enforces every limit.

## The problem

- Front-running and sandwich attacks: bots read pending orders in the public queue, trade ahead, and the user gets a worse price. Cite a sourced yearly figure for sandwich losses on Ethereum or Solana in the README, with date and source.
- QoreChain's own fix, FairBlock threshold-encrypted transactions, is a stub on both networks (disabled; REST answers "Not Implemented"; waits on a validator key ceremony with no date). The native `x/amm` only has a 5% price-impact cap and a block-open price check for swaps with no slippage bound.
- Honest framing: there are no MEV bots on QoreChain yet. Blind ships protection before the market grows, at app level, while the protocol fix is not live.

## Who it is for, and the front door

Anyone swapping on QoreChain. Judges get test tokens from a relayer, place a sealed swap, and watch the batch settle in about a minute, with no wallet funding.

## The engine ("Blind Quote", the design the fresh judge lifted to about 7.4)

1. **Intent.** The user signs "swap A for at least X of B, expires at block N" with their ML-DSA-87 key and seals it with QoreSeal (ML-KEM-1024) to the batch key. The sealed envelope is posted on chain, so it cannot be dropped quietly.
2. **Commit before open.** Each batch, the AI market maker commits an ML-DSA-87-signed **quote curve** on chain (price as a function of net size, plus a max size) **before** any intent can be opened. Trustee key shares for the batch are released only after the commit block. So nobody, the AI and the operator included, sees an order before the price is fixed, and the ordering is checkable on chain.
3. **Open and match.** After the commit, the batch key opens the intents. Opposite intents match against each other; the net remainder fills from the agent's inventory at the committed curve.
4. **Settle atomically.** One `settle()` on the EVM lane: checks every intent signature and the agent's quote signature with `pqcVerify` (0x0A01) against keys read from `pqcKeyStatus` (0x0A02, `possessionProven` required), checks the clearing price equals the committed curve at the realised net, enforces each user's signed min-out, and moves every leg in one transaction. Users approve the settlement contract for the Fest ERC-20s (fUSD, fETH, fBTC); funds stay in their accounts until settlement.
5. **The agent's account is confined.** The settler account (the drill account) runs in a scoped EVM window: `allowed_targets` = settlement contract only, `max_txs`, short expiry; optionally also linked as a rule-bound key with `allowed_evm_calls` limited to `settle()`. It holds no inventory. **Hedging runs from a separate account** that holds its own PQ key and trades on `x/amm`.
6. **The AI does real, scored work.** It sets a blind spread from inventory, AMM state and volatility, before seeing orders. It is scored per batch on markout: its PnL after the fill against the AMM's weighted average price. The model proposes; the contract decides (signatures, committed curve, user min-out, caps).
7. **Stop and limit orders** as standing sealed intents, re-checked every batch. Honest wording: hidden from the public and bots; the batch trustees see them at each check.
8. **Proof page per batch:** commit block vs open block, sealed and opened intents, clearing price vs the AMM average and vs a plain `x/amm` quote at the open block, each user's fill, and the agent's committed spread vs realised markout.

## Facts the judges established (do not repeat these mistakes)

- QoreChain linked keys (x/abstractaccount authenticators) **cannot run x/amm swaps**: `MsgExecuteCosmos` is a bank send only, and EVM has no AMM precompile. Settlement is therefore one EVM contract.
- Matching two users with separate bank sends is not atomic (v3.2.8 returns code 0 with `success=false` on a failed execution). Use the single `settle()`.
- **Drill hole to avoid:** if `settle()` took the agent's quote from `msg.sender`, the bot (holding the settler's classical key) could settle against its own intent at an absurd price and drain inventory. The quote must be ML-DSA-signed and checked with `pqcVerify`, and the settler account holds no inventory.
- "The chain enforces a fair price" is false. The contract enforces only signed min-outs and the committed curve. Say exactly that.
- The operator runs the trustees and the agent, so it can read every order after open. The commit-before-open rule stops it from pricing against the flow; the README says plainly who can read what and when.
- `max_value` on a window caps QOR only; ERC-20 movement is bounded by `allowed_targets`.
- AI-Native is about AI used while building (Claude Code), not the product's agent.
- Each user needs an ML-DSA key registered with possession proof, a window or approve, so "no wallet funding" means a relayer pays for burner setup. Build it.

## Already live (17 Nov)

| What | Where |
|---|---|
| Drill account | `qor12xlna2e4qdpqumgvmfdq62lqmppshrwha4sjva` / `0x51BF3eab3503420e6d0CDa5a0D2bE0D8430b8dD7`, ML-DSA registered with possession proof, no window open |
| DrillVault (settlement core) | `0x150babdc7e487ea5f46c0c3236dea4c0e0b79053` (`qor1z596hhr7fpl2tarvpserdh4ycrst0yzn0mjhlp`), 50 QOR; withdraw needs the owner's ML-DSA-87 signature via `pqcVerify` (real accepted, forged refused) |
| Scripts | `scripts/drill.ts` (status, register, deploy, fund, selfsend); mnemonic in a local git-ignored `.env` (copy lives at `~/urn-launch/spike/.env`) |

**Drill day, 18 Nov UTC:** run `npx tsx drill.ts selfsend` from `~/urn-launch/spike` (has node_modules and .env) and give the owner the hash to submit. Never open a window on the drill account during the drill.

## How it meets the Agents brief (from /prizes)

| Jury expects | Where |
|---|---|
| Scoped EVM window | Settler account: allowed_targets = settlement contract |
| Limits on tx, value, duration, targets | Window bounds plus the committed curve's max size |
| Smart-account spending rules | Rule-bound linked key with `allowed_evm_calls` = `settle()` |
| Authenticated messaging | Every intent and every quote is ML-DSA-87 signed and verified on chain |

## The numbers

- Per batch, each user's fill vs a plain `x/amm` quote at the open block (measured live, misses published).
- The agent's committed spread vs realised markout per batch.
- Drill result: attempts made by the bot and value kept (published after the drill).
- Optional, labelled as simulation: replay of public sandwich cases from other chains.

## The field (17 Nov, fresh judge)

Agents has 19 entries, almost all leash/limit agents. Leader Fenestella about 8.0, Qill-switch 7.4, Sentinel 7.2. Likely 1st needs about 8.3; likely 2nd about 7.4. Blind is the only batch-auction / MEV entry. Report rivals only in chat, never in the README.

## What it does not do

- It does not make QoreChain's mempool private (FairBlock's job); it protects orders placed through Blind.
- It is not trustless: the trustees (the operator) can read orders after the commit block.
- It has no mainnet pools to trade against yet.

## Audit

The fest FAQ says jurors read the QCAI contract-audit reports. Run the final settlement contract through the dashboard auditor (both stages, owner's login) and answer every finding in the README.
