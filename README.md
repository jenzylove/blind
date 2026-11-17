# Blind

Trade on QoreChain without bots seeing your order first.

Work in progress for Build Before Q-Day, the QoreChain Developer Fest (Post-Quantum AI Agents).

## Live on testnet now

`DrillVault` is Blind's settlement core, deployed on `qorechain-diana` for the Q-Day Drill.

| | Address |
|---|---|
| Drill account | `qor12xlna2e4qdpqumgvmfdq62lqmppshrwha4sjva` (`0x51BF3eab3503420e6d0CDa5a0D2bE0D8430b8dD7`) |
| DrillVault | `0x150babdc7e487ea5f46c0c3236dea4c0e0b79053` (`qor1z596hhr7fpl2tarvpserdh4ycrst0yzn0mjhlp`) |

The vault holds 50 test QOR. Money leaves only with an ML-DSA-87 signature from the owner's key registered on QoreChain (read from `pqcKeyStatus` at `0x0A02`, possession proven) and checked on chain by `pqcVerify` at `0x0A01`. Nothing trusts `msg.sender`, so the account's classical key alone cannot move anything. A real signature is accepted and a forged one is refused.

## Scripts

```sh
npm install
cp .env.example .env   # testnet-only mnemonic
npm run drill status   # balance, key, window, vault
npm run drill selfsend # the normal transaction for drill day
```

## Licence

MIT
