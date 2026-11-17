# Spike: the hedging account swaps on x/amm with a hybrid signature

**Question.** Can a separate hedging account run `MsgSwapExactIn` on the native AMM, hybrid signed (ML-DSA-87 + secp256k1), with a real min-out?

**Run (17 Nov 2026, testnet).** Hedging account `qor1j4mrfz0l2mf6cmduxngm70rjejm5slj2xvrvkd`, ML-DSA key registered with possession proof. Pool 3 (fETH / fUSD, constant product).

| Step | Result |
|---|---|
| Quote `/qorechain/amm/v1/quote/exact_in` for 5 fUSD | 0.001821822580716099 fETH, fee 15000, impact 133 bps |
| Swap 5 fUSD with min-out = quote minus 1%, tx `8A8E9781F837AC85F20828DB7036D3C4CE855C580654B85792AF70A8140A0ED8` | code 0, received exactly the quote; `amm_swap` event: fee 30 bps, protocol fee 10 bps |
| Swap with min-out = 2x the quote, tx `1A977217…C5C65` | refused by the chain: `slippage tolerance exceeded` |

**Verdict: holds.** Hedging works from its own account, with no EVM window and nothing shared with the settler.

**Note for Phase 3.** Pool 3 is thin (about 370 fUSD on one side). Five fUSD already moves the price 1.33%, and the chain caps any swap at 5% impact. Keep the market maker's max size small, and have the agent read live reserves before each quote.
