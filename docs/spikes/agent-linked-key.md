# Spike: the agent acts through a linked key bound by an on-chain spending rule

**Question.** Can the market maker agent act through its own key, linked to the operator account, with QoreChain itself refusing anything outside an allow-list? And can the agent still play its part in a Blind batch that way?

**How.** QoreChain's account abstraction lane:
- `MsgUpdateSpendingRules` and `MsgRegisterAuthenticator` are sent together in one owner-signed transaction (`linkAuthenticatorMsgs` in `@qorechain/sdk`).
- The agent then signs `MsgExecuteEVM` with its ed25519 key. The operator relays it and pays the fee.
- The rule lists `allowed_evm_calls` as `0x<contract>/0x<selector>` entries, plus value limits.

## Run 1: test account (USER1), 22 Nov 2026

Script: `scripts/spike-agent-link.ts`. Rule: fUSD `approve` and BlindSettlement `batchCount()` only, 0.2 QOR per transaction, 1 QOR a day.

| Call through the agent key | Result |
|---|---|
| Link, tx `F4FBEBC5…399E` | code 0. The rule and the key read back from `/qorechain/abstractaccount/v1/...` |
| BlindSettlement `batchCount()` (listed), tx `4B578A85…69CC` | ran, no failure event |
| BlindSettlement `withdrawNonce()` (not listed), tx `3AC29730…9234` | refused by the chain: "a linked key with a spending rule may call 0xbdBd…f3cf with data only if the rule lists the call in allowed_evm_calls" |
| fUSD `transfer` (not listed) | refused, same reason |
| fUSD `approve` (listed) | refused anyway: the chain also blocks token approvals unless the rule covers the token itself |

A refused call still lands as a successful transaction. The refusal shows up as an `abstractaccount_execution_failed` event with the reason, and it uses up the key's nonce. The engine reads that event and treats it as a failure.

## Finding: calls through this lane emit no EVM logs

We first routed every operator call through the agent key (live batch 14). The calls ran and contract storage changed:
- `sealedCount` = 1
- `commitBlock` and `openBlock` set

But no `Sealed`, `Committed` or `Opened` event appeared to `eth_getLogs`. The Cosmos transaction carries no EVM log event either. `MsgExecuteEVMResponse` has only `success`, `ret`, `gasUsed` and `vmError`.

Blind's promise depends on public events: anyone can open every sealed order and check every fill. So:
- The steps that make a batch checkable (`post`, `open`, `settle`) stay on the operator's scoped EVM window, where events are normal.
- The agent's key is limited to its one decision: committing its price curve.
- The committed curve stays readable on chain through `curveOf(batch)` and the batch storage. The contract still checks the agent's ML-DSA-87 signature over it.

## Run 2: live, on the operator account

| What | Value |
|---|---|
| Agent key (ed25519) | `0xd6c12f40051980dcc8f1c0c2fe110c29a6a67c88c66c209ca99be3d3f9fe938c` |
| Linked to | `qor1ugpasg28ytchzqdts4jgajgqhwglh6y3xtuw8t` (operator) |
| Rule | `allowed_evm_calls` = `0xbdbd…f3cf/0x6225710f` (`commit` only), 1 uqor per transaction, 1 uqor a day |
| Rule update tx | `5801B8FD…5494` |
| Key expiry | 29 days after linking (the chain caps a linked key at 720 hours) |
| First batch with the agent's commit through the key | batch 15. The commit is a `MsgExecuteEVM` with no failure event, tx `E3C11771…DE50`. Settled the same minute with one fill. |

**Verdict: passes.** The leash is enforced by the chain, not by our code. A stolen agent key can only commit curves to Blind, and every curve still needs the agent's ML-DSA-87 signature and is bounded by the user's signed minimum. The trade-off is that the agent's commit carries no EVM event, which is why it is the only call on this lane.
