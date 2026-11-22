# How AI was used to build Blind

Blind is built by one person working with Claude Code (Anthropic) as a coding and research partner. This file records what the AI did, what the human decided, and how the AI's work was checked. It is updated as the build goes on.

## What the AI did

| Area | What Claude Code did |
|---|---|
| Research | Read the QoreChain docs, the QoreSeal and workshop source, and the live testnet REST to find what is really live: `pqcVerify` and `pqcKeyStatus` on testnet, the EVM window rules, which account-abstraction lanes exist, and that FairBlock is still a stub. |
| Idea review | Helped test ideas against the fest's projects and against live products, and ran independent reviewer agents that scored each idea and pointed out factual errors. Those reviews changed the design: limited keys cannot run AMM swaps, so settlement moved to one atomic EVM contract; agent quotes must be signed so the drill account cannot be drained. |
| Contracts | Wrote `DrillVault.sol`, which releases funds only on a valid ML-DSA-87 signature from the owner's registered key. |
| Scripts | Wrote `scripts/drill.ts`: register the post-quantum key with proof of possession, open a short EVM window, deploy, close the window at once, fund the vault, and send the drill-day normal transaction. |
| Spikes | Ran four time-boxed spikes against the live testnet before any product code: two signatures settling in one transaction, commit strictly before open, hedging on x/amm, and a relayer funding a fresh browser account (`docs/spikes`). Later ran a fifth spike for the agent's linked key, which found that calls through that lane emit no EVM logs. That finding shaped the design. |
| Contract | Wrote `BlindSettlement.sol` and its 31 Foundry tests: every drill attack, fuzzing of the price band and of the curve's fixed point, and tests answering each QCAI finding. When the first version missed, it designed the fix with the owner: a committed quote curve with an exact fixed-point price, solved in the contract. |
| Market maker agent | Wrote the quoting policy (`src/agent/policy.ts`): curve endpoints from the x/amm hedge cost, a margin, inventory skew, and volatility that ignores our own hedges. 11 unit tests check it against the chain's own quotes. Also wrote the engine, which runs a batch end to end and hedges on x/amm. |
| Measurement | Ran unattended batches on testnet, computed every fill against a plain x/amm swap and the agent's markout 30 blocks later, and published the misses (`docs/BUILD_LOG.md`, `/proof`). |
| Server and web app | Wrote the batch loop, the relayer and the API. Then briefed and reviewed a second agent that built the web app. Keys never leave the browser: it seals and signs every order there. |
| Linked agent key | Linked the agent's own key to the operator account with an on-chain spending rule: it may only commit price curves to Blind (`scripts/link-agent.ts`, `docs/spikes/agent-linked-key.md`). |
| Audits | Ran QoreChain's QCAI auditor (the owner signed in and clicked run). Checked every finding against the code and answered each with a test (`docs/audit/QCAI.md`). Then ran an independent release-readiness audit with a fresh agent. That audit found that one bad order could stall a batch and that explorer links were dead, and both were fixed. |

## What the human decided

- Which idea to build, after rejecting several the AI proposed.
- Entering the Q-Day Drill, and what goes into the project page.
- Every public action: creating and publishing the repository, funding accounts from the owner's wallet, and submitting forms.
- Fixing the first version's miss instead of hiding it, and choosing the curve design.
- Keeping Blind in the AI Agents track by building the agent's linked key, rather than switching tracks.
- The visual design: rejected the first web design for repeating the owner's other products, and chose the venetian blind direction.
- Deploying with testnet keys on the host, and running the paid QCAI audit.

## How the AI's work was checked

- Every chain claim was tested against the live testnet before it was written down, not taken from memory.
- The vault was tested on chain before any value went in: a real ML-DSA-87 signature was accepted and a forged one was refused (simulated call), and the vault read back the owner's full 2,592-byte registered key.
- Every transaction in this repository's history has a hash on the `qorechain-diana` explorer.
- Every agent-written change ran against the live chain before it was committed: a real batch settled from a fresh browser after each deploy.
- An outside agent with no build context audited the repository and the live site. Its findings were checked against the code before being fixed.
- The batch records the site serves were checked against the contract's own on-chain events, block by block.

## Limits

The AI can be wrong about a fast-changing chain. Where this repository states a fact about QoreChain, it was checked against the docs or the live chain on the date of the commit.
