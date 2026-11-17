# Spike: the batch cannot be opened until the quote is committed, and never in the same block

**Question.** Can the contract enforce, on chain, that the batch key is revealed only in a block after the market maker's signed quote is committed?

**Design tested.** At creation the batch stores `keccak256(batch secret key)`. `commit` checks the agent's ML-DSA-87 signature over `(chain id, contract, batch, keccak256(curve))` and records the block. `open` accepts the secret key only if its hash matches and `block.number > commitBlock`.

**Run (17 Nov 2026, testnet).** Contract `0x5eac347899cb57f754958b807baf65587547282f`, batch id `1794949264`.

| Step | Block | Result |
|---|---|---|
| `create` | 10276515 | success |
| `post` a 1,700 byte sealed envelope | 10276517 | success |
| `open` before any commit | n/a | refused: `quote not committed` |
| `commit` with a forged agent signature | n/a | refused: `bad ML-DSA-87 signature` |
| `commit` (real signature), tx `0x2292fc1a…0a63` | 10276520 | success |
| `open` sent right behind it with the next nonce, tx `0x77b90f1e…789c` | **10276520 (same block)** | **reverted**: the contract refused to open in the commit block |
| `open` retried, tx `0x3663c45f…75bf9` | 10276522 | success |

**Verdict: holds.** The ordering rule is enforced by the contract, and the run caught the exact race it exists for (open and commit landing in one block). The order envelope sits on chain from block 10276517, so it cannot be dropped quietly.

**Honest limit, unchanged.** Whoever holds the batch secret key can decrypt envelopes off chain before the commit. The contract proves the commit came before the public open, not that nobody peeked. The README must say who holds the key shares.
