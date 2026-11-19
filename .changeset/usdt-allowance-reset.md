---
"@ledgerhq/agent-intent-sdk": minor
---

Add `canResetSwapAllowance`, so the Agent Intent app can reset a USDT allowance left on Ethereum to 0 with the Swap API's own approval transaction before it approves the swap amount. With an allowance left, that transaction is `approve(spender, 0)`. `canResetSwapAllowance` accepts it only when `canApproveSwapQuote`'s rules on the network, the provider, the spender and the sold token hold, `needsAllowanceReset` is true, and the approved amount is exactly 0. `canApproveSwapQuote` still refuses such a quote.

`parseErc20Approval` now also returns the approved `amount`, and `SwapApprovalQuote` takes it as `approvalAmount`.
