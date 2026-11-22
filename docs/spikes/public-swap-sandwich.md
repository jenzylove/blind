# Spike: a bot can sandwich a public x/amm swap on QoreChain

**Question.** Can a bot watching QoreChain's public mempool get its own x/amm swap in ahead of someone else's, and take value from them? This is the threat Blind exists for. If it happens on QoreChain, a judge should be able to watch it happen to their own public swap.

**Setup (22 Nov 2026, `qorechain-diana`, pool 3 fETH/fUSD).**
- The victim (`qor1zghg…k5x`) sends a normal public `MsgSwapExactIn`: 5 fUSD for fETH, with a 3% slippage limit and the normal fee.
- The bot (`qor1qprw…lcq`) polls the public `unconfirmed_txs` RPC.
- When the bot sees the victim's swap, it broadcasts its own buy of 6 fUSD with a 10× fee, then sells back after the victim's swap lands.

Script: `scripts/spike-sandwich.ts`.

| Run | Bot polling | Bot fee | Victim vs quote | Same block | Who went first |
|---|---|---|---|---|---|
| 1 | 80 ms | 10× | −2.86% | yes | **bot** (bot P&L +0.108 fUSD) |
| 2 | 80 ms | 10× | 0.00% | no | victim, one block earlier |
| 3 (control) | 80 ms | 1× | 0.00% | yes | victim |
| 4 | 40 ms | 10× | 0.00% | no | victim, one block earlier |
| 5 | 40 ms | 10× | −2.73% | yes | **bot** |
| 6 | 40 ms | 10× | −2.70% | yes | **bot** |
| 7 | 40 ms | 10× | −2.67% | yes | **bot** |
| 8 | 40 ms | 10× | −2.64% | yes | **bot** |

Example of run 1, all on chain:
- victim `1365C966…CB9C`
- bot front-run `64DD2A76…91A8`, same block 10541376, ahead of the victim
- bot back-run `D9760702…98C3`

**What we learned.**
- The mempool is public. The bot saw the victim's swap about 100 ms after it was sent.
- Within a block, transactions are ordered by fee. With equal fees the victim went first (run 3). With a 10× fee the bot went first every time the two shared a block.
- The bot misses only when the victim's swap closes out a block before the front-run arrives. With 40 ms polling the bot got ahead 4 times out of 5.
- When it lands, the victim loses almost their whole slippage allowance: 2.6% to 2.9% of a 3% limit.

**Verdict: passes.** A sandwich on QoreChain's public x/amm is real and repeatable. Blind's sealed orders give a bot nothing to see: they sit on chain as same-size ML-KEM-1024 envelopes until the price is locked.
