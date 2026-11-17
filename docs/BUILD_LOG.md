# Build log

| Date | What now works |
|---|---|
| 17 Nov 2026 | DrillVault live on testnet for the Q-Day Drill: withdrawals need the owner's ML-DSA-87 signature, checked on chain. |
| 17 Nov 2026 | Phase 1 spikes pass on testnet: one `settle()` checks two ML-DSA-87 signatures and moves both legs (about 413k gas); the contract refuses to open a batch in or before the quote commit block (caught live); the hedging account swaps on x/amm with a hybrid signature; a relayer onboards a new user in 49 s for 0.21 QOR; a scoped window refuses any other recipient. See `docs/spikes/`. |
| 17 Nov 2026 | `BlindSettlement` written and tested: 24 Foundry tests pass, including every drill attack (forged quote, forged or tampered order, replay, order for another batch, min-out, maker size cap, inventory withdrawal without the agent) and a fuzz test that the price never leaves the committed band. The contract computes the clearing price itself; the settler never supplies one. |
| 17 Nov 2026 | First real batch on testnet (`deployments/testnet.json`): two ML-KEM-1024 sealed orders posted on chain, ML-DSA-87 quote committed in block 10279255, seed revealed in 10279258, both orders opened from chain logs and settled atomically in 10279261 at one price (548k gas). The seller got 11.126 fUSD where a plain x/amm swap gives 10.743; the buyer's 20 fUSD order filled where x/amm refuses it (over the 5% impact cap). |
