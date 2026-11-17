# Build log

| Date | What now works |
|---|---|
| 17 Nov 2026 | DrillVault live on testnet for the Q-Day Drill: withdrawals need the owner's ML-DSA-87 signature, checked on chain. |
| 17 Nov 2026 | Phase 1 spikes pass on testnet: one `settle()` checks two ML-DSA-87 signatures and moves both legs (about 413k gas); the contract refuses to open a batch in or before the quote commit block (caught live); the hedging account swaps on x/amm with a hybrid signature; a relayer onboards a new user in 49 s for 0.21 QOR; a scoped window refuses any other recipient. See `docs/spikes/`. |
