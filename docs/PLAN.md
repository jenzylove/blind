# Plan: Blind

Deadline 2 Dec 2026, 23:59 UTC. Each phase ends with a check.

## Phase 0. Drill day (18 Nov UTC) — do not skip
- Run the selfsend from `~/urn-launch/spike` and give the owner the hash for the project page.
- Do not open any window on the drill account during the drill.
- **Check:** hash submitted; after the drill, vault and account balances unchanged.

## Phase 1. Spikes (half a day)
- Settle path: deploy a minimal settlement contract; verify two ML-DSA-87 signatures (an intent and a quote) via `pqcVerify` in one transaction; measure gas.
- Commit-then-open ordering: commit a signed quote in block N; refuse any open before N.
- Hedge path: the hedging account runs a hybrid-signed `MsgSwapExactIn` on an x/amm pool with fUSD.
- Relayer: fund a burner, register its ML-DSA key with possession proof, approve fUSD.
- Write `docs/spikes/*.md` for each.
- **Gate:** any failure is reported to the owner with a changed plan before building on it.

## Phase 2. Contracts
- `Settlement.sol`: commit(quote curve, sig), post(sealed envelope), settle(batch) with signature, curve and min-out checks, atomic legs.
- Foundry or Hardhat tests, including the drill attacks: settler classical key cannot settle against a fake quote, cannot move inventory, cannot widen limits.
- Run the QCAI auditor (owner's dashboard login), answer findings.
- **Check:** tests pass; a two-user batch plus an agent fill settles on testnet with explorer links.

## Phase 3. Agent
- Quote policy (spread from inventory, AMM state, volatility), committed before open.
- Hedger on x/amm from its separate account.
- Markout scoring per batch, published.
- **Check:** ten batches run unattended; markout table on the proof page.

## Phase 4. Web app and relayer
- Sealed swap, stop and limit orders, batch timeline, proof page; burner onboarding with no funding.
- **Check:** a fresh browser places a sealed swap and sees it settle in about a minute; headless run of every button, dark and light.

## Phase 5. Design, audit, launch
- Own bold direction; release-readiness-audit; README (judge fast path, what is real, who can read what and when); video up to 3 minutes; update the project page (repo, video, demo, testnet addresses).
- **Gate:** owner approves the live product before the video.

## Risks
| Risk | Status |
|---|---|
| `pqcVerify` twice per settle fits gas | Needs spike (single verify ~85 to 90k gas; full ballot-sized tx estimated 220 to 250k) |
| Thin testnet pools for hedging | Known: 5 pools, thin; size inventory small |
| Judge alone sees no matching | Known: the agent fills; proof shows fill vs plain swap |
| Operator can read orders after open | Known: commit-before-open; say so in README |
