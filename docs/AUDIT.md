# Security audits of BlindSettlement

QoreChain's AI auditor (QCAI, dashboard.qorechain.io/audit) has reviewed the settlement contract three times. Each time we changed the contract or added a test for what it found, then deployed again.

| Date | Contract | Score | Report |
|---|---|---|---|
| 22 Nov 2026 | v2 `0xbdbd8fa8247a9bbc598f72cb46a2c7e3194ef3cf` | 72 | findings and answers in [audit/QCAI.md](audit/QCAI.md) |
| 24 Nov 2026 | v4 `0x036701960d6e42e6d167222a917405ba3315a79b` | 72 | [audit/2026-11-24-qcai-v4-score-72.pdf](audit/2026-11-24-qcai-v4-score-72.pdf) |
| 24 Nov 2026 | **v5 `0x143e9152c9a1b97668d6fbd23126e1616275aac7` (live)** | **78** | [audit/2026-11-24-qcai-v5-score-78.pdf](audit/2026-11-24-qcai-v5-score-78.pdf) |

Run every test below with `forge test` (56 tests, fuzzed; CI runs them at 5,000 fuzz runs).

## What the v4 audit changed (v5)

Every v4 finding was fixed in the code, not only answered.

| v4 finding | Severity | Change in v5 | Test |
|---|---|---|---|
| Missing access control on `commit` | High | Explicit `onlySettler` and `onlyMaker` modifiers on every role gated function (`open`, `post`, `commit`, `settle`), lines 134 to 143 | `test_v5_commitRefusesEveryOtherRole`, `test_onlyTheSettlerOpensAndSettles` |
| Overflow in `_solve` | High | Solidity does not check a `uint256` to `int256` conversion. Every one now goes through `_int` (line 333), which reverts instead of wrapping, and batch totals are capped at 2^128 (line 367) | `test_v5_solveRevertsInsteadOfWrapping`, `testFuzz_qcai_solveHasNoOverflowInRange` (20,000 runs) |
| Front running in `reveal` | Medium | Only the order's own user, or the settler relaying it, may reveal (line 290). The curve is fixed before any reveal and every order fills at one price, so seeing a reveal early gains nothing | `test_v5_revealOnlyByItsUserOrTheSettler`, `test_v4_cannotRevealBeforeTheCommit` |
| Unbounded loop in `settle` | Medium | The 32 order cap is now the first check in `settle` (line 357) | `test_v5_settleRefusesMoreThan32OrdersFirst`, `test_v4_postsAreBounded` |
| Unchecked transfer return values | Low | They were checked already; the helpers are now named `_safeTransfer` and `_safeTransferFrom` and say what they check | `test_v5_falseOrGarbageTransferReturnReverts` |
| *(found by us, not by QCAI)* Anyone could post fingerprints straight to the contract and fill a batch with 64 that would never be revealed | | `post` is settler only (line 256) | `test_v5_onlyTheSettlerPosts`, and the live "Flood a batch" attack at [blind.jdollar.site/attack](https://blind.jdollar.site/attack) |

## The v5 audit, finding by finding

| v5 finding | Severity | Where the contract handles it | Test |
|---|---|---|---|
| `setMandate` lets anyone update the mandate | High | Any account may *send* it, by design: the owner's key is an ML-DSA-87 key, so its signature is the access control. The contract checks it with `pqcVerify` against the key `pqcKeyStatus` reports, over a nonce that moves on every change (line 226) | `test_v5_setMandateNeedsTheOwnersFreshSignature`, `test_v4_mandateSignatureCannotBeReplayed`, live: [a stranger's mandate refused on chain](https://blind.jdollar.site/attack) |
| Overflow in `clearingPrice` | High | Totals are capped at 2^128 before the price is computed (line 367), so `quoteIn * PRICE_SCALE` stays below 2^188. All math is Solidity 0.8 checked math, and every signed conversion goes through `_int` | `testFuzz_qcai_solveHasNoOverflowInRange`, `testFuzz_curve_priceIsTheFixedPoint`, `test_v5_solveRevertsInsteadOfWrapping` |
| Front running in the reveal phase | Medium | Reveals open only after the market maker's curve is locked on chain, are restricted to the user or the settler, and cannot change the price: it comes from the locked curve and is the same for every order | `test_v5_revealOnlyByItsUserOrTheSettler`, `test_v4_settleWaitsForEveryRevealOrTheWindow` |
| Unbounded loop in `settle` | Medium | `MAX_ORDERS` (32) is enforced before any work (line 357), which is the fix QCAI recommends | `test_v5_settleRefusesMoreThan32OrdersFirst` |
| Return values that are not a bool | Low | `_safeTransfer` decodes the return as a bool; a token that returns `false` or returns data that is not a bool reverts the whole call | `test_v5_falseOrGarbageTransferReturnReverts` |

## How the post quantum checks are used

| Who signs | What | Checked by |
|---|---|---|
| Each user | their order, under QoreChain's message domain `qorechain-msg-v1|qorechain-diana|` | `pqcVerify` (`0x0A01`) inside `settle`, against the key `pqcKeyStatus` (`0x0A02`) reports as registered and proven |
| The market maker agent | its price curve | `pqcVerify` inside `commit` |
| The owner | the mandate, and every withdrawal | `pqcVerify` inside `setMandate` and `withdraw` |

`keyOf` (line 171) refuses a key that is not registered as ML-DSA-87 or whose possession is not proven; `_verify` (line 181) refuses any signature the precompile does not accept. Tests: `test_unprovenKeyRefused`, `test_drill_forgedOrderRefused`, `test_drill_forgedQuoteRefused`, `test_v4_mandateNeedsTheOwnersSignature`, `test_withdrawNeedsTheOwner`. Foundry runs them against stand ins for the two precompiles; on the live chain the same refusals are real transactions in the attack log (`/api/attacks`).

## Beyond the auditor

- **Try to rob it:** nine real attacks on the live contract, each refused on chain, logged publicly: https://blind.jdollar.site/attack
- **Check it yourself:** `npm run verify` reads only the public chain and site and checks the contract, the mandate, the agent's spending rule, the keys, every recent batch and the attack log.
- **CI:** the contract tests, the unit tests and the verify run on every push and daily ([.github/workflows/verify.yml](../.github/workflows/verify.yml)).
