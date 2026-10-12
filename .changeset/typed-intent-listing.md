---
"@ledgerhq/agent-intent-sdk": minor
---

Type listed intents as `AgentIntentSendOperation` (with Solana's `memo`) or `AgentIntentSwapOperation`, narrowed with `isSendOperation` and `isSwapOperation`, and reject a send or swap with a missing or mistyped field.
