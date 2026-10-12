---
"@ledgerhq/agent-intent-sdk": minor
---

Type listed intents: `AgentIntentOperation` is now `AgentIntentSendOperation` (with Solana's `memo`) | `AgentIntentSwapOperation` | an unknown type, narrowed with `isSendOperation` and `isSwapOperation`. A send or swap with a missing or mistyped field is rejected; code that read `amount`, `asset` or `network` without narrowing must narrow first.
