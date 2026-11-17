# Spike: two ML-DSA-87 checks and both token legs in one `settle()`

**Question.** Can one EVM transaction verify a user's signed intent and the market maker's signed quote through the `pqcVerify` precompile (0x0A01), using keys read from `pqcKeyStatus` (0x0A02, possession proven), then move both token legs? What does it cost?

**Run (17 Nov 2026, testnet `qorechain-diana`).** Throwaway contract `SpikeSettle` at `0x5eac347899cb57f754958b807baf65587547282f` (deploy tx `0x814d84c71db09a9eb38925893fc07e398b5bdba289308942a4e49e840d0edc00`). Market maker stock: 0.05 fETH moved into the contract with a Cosmos lane `MsgConvertCoin` (tx `3660EBF1…D883C`), no EVM transaction needed.

| Step | Result |
|---|---|
| `settle` (user sig + quote sig + `transferFrom` fUSD in + `transfer` fETH out) | success, tx `0x983ad358fef43ec1a233b5cfc9984857c15174ad3585e4a96364b96fb8ad8098`; user received 0.0037 fETH for 10 fUSD |
| Forged quote signature | refused: `bad ML-DSA-87 signature` |
| Intent changed after signing (amountIn 10 to 90, real signature) | refused: `bad ML-DSA-87 signature` |
| Payout one unit below the user's signed min-out | refused: `below the user's signed min-out` |
| Same signed intent submitted again | **accepted** (the spike has no used-intent guard) |

**Gas.** `eth_estimateGas` for the full settle: **413,449**. At 112.5 gwei that is about 0.047 QOR per settle. The chain charged exactly half the gas limit on every transaction in this spike (limit 1,500,000, charged 750,000; limit 200,000, charged 100,000), so set each gas limit tightly from an estimate.

**Verdict: holds.** Two post-quantum checks and both legs fit easily in one transaction. Carry into Phase 2:
- Mark each intent used (hash or per-user nonce) so a settled intent cannot be replayed.
- Verify the quote once at commit and store it; settle only needs the user check. That cuts about one verify per fill.
- Gas limit = estimate plus a small margin, never a round guess.
