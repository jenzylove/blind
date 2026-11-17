# How AI was used to build Blind

Blind is built by one person working with Claude Code (Anthropic) as a coding and research partner. This file records what the AI did, what the human decided, and how the AI's work was checked. It is updated as the build goes on.

## What the AI did

| Area | What Claude Code did |
|---|---|
| Research | Read the QoreChain docs, the QoreSeal and workshop source, and the live testnet REST to find what is really live: `pqcVerify` and `pqcKeyStatus` on testnet, the EVM window rules, which account-abstraction lanes exist, and that FairBlock is still a stub. |
| Idea review | Helped test ideas against the fest's projects and against live products, and ran independent reviewer agents that scored each idea and pointed out factual errors. Those reviews changed the design: limited keys cannot run AMM swaps, so settlement moved to one atomic EVM contract; agent quotes must be signed so the drill account cannot be drained. |
| Contracts | Wrote `DrillVault.sol`, which releases funds only on a valid ML-DSA-87 signature from the owner's registered key. |
| Scripts | Wrote `scripts/drill.ts`: register the post-quantum key with proof of possession, open a short EVM window, deploy, close the window at once, fund the vault, and send the drill-day normal transaction. |

## What the human decided

- Which idea to build, after rejecting several the AI proposed.
- Entering the Q-Day Drill, and what goes into the project page.
- Every public action: creating and publishing the repository, funding accounts from the owner's wallet, and submitting forms.

## How the AI's work was checked

- Every chain claim was tested against the live testnet before it was written down, not taken from memory.
- The vault was tested on chain before any value went in: a real ML-DSA-87 signature was accepted and a forged one was refused (simulated call), and the vault read back the owner's full 2,592-byte registered key.
- Every transaction in this repository's history has a hash on the `qorechain-diana` explorer.

## Limits

The AI can be wrong about a fast-changing chain. Where this repository states a fact about QoreChain, it was checked against the docs or the live chain on the date of the commit.
