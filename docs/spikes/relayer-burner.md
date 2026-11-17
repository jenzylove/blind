# Spike: a relayer onboards a user with no funding of their own

**Question.** Can a relayer take a brand new key from nothing to "approved for settlement" without the user holding QOR first, and how long and how much does it cost?

**Run (17 Nov 2026, testnet).** Burner `qor1zghglxxu3serxz3gzxrk747upg09dyvdxl3k5x` / `0x122e8F98Dc8C32330a2811876F57DC0a1e56918D`.

| Step | Who signs | Result |
|---|---|---|
| Send 1.5 QOR and convert 100 fUSD straight into the burner's `0x` address as ERC-20 (`MsgSend` + `MsgConvertCoin` in one tx, `9C414AFB…A8266`) | relayer | code 0 |
| Register the burner's ML-DSA-87 key with possession proof (`97D06572…21A0`) | burner | code 0 |
| Open a window: 1 transaction, allowed recipient = fUSD contract only (`4CC085B0…3FD1`) | burner | code 0 |
| `approve(settlement, max)` on fUSD (`0x779a8d09…229c`) | burner | success |

Total: **48.9 seconds**, **0.21 QOR** spent by the burner from what the relayer sent. The burner ends with 100 fUSD and the allowance set.

**Also proven (settler window scope).** A window opened with `allowed_targets = [settlement contract]` refused a transaction to the fUSD contract: "the window does not list 0x97143B…63CA as an allowed recipient". A window also refused a deploy whose fee cap went past the window's value budget. The value bound counts gas limit × max fee per gas, so budget windows from the fee cap the wallet will actually send.

**Verdict: holds.** About 50 seconds to onboard fits the "trade within a minute" front door if onboarding starts when the page opens. With the relayer's own 0.1 QOR fee, each new user costs about 0.31 QOR, so the faucet's 100 QOR a day covers about 320 new users. The relayer needs a daily top up, a per visitor rate limit, and should send less than 1.5 QOR (the burner used only 0.21).
