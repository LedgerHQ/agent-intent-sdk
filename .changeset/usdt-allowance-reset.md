---
"@ledgerhq/agent-intent-sdk": minor
---

Add `canResetSwapAllowance`, which says whether the Agent Intent app can send a quote's `approve(spender, 0)` to reset a USDT allowance left before it approves the swap amount; `SwapApprovalQuote` takes the approval's amount as `approvalAmount`.

`parseErc20Approval` now returns the approved `amount`, so `Erc20Approval` gains it as a required member: code that builds an `Erc20Approval` by hand, such as a test double, must add it. `amount` is a `bigint`, so `JSON.stringify` throws on a parsed approval; convert it first, for example with `amount.toString()`.
