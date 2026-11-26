---
"@ledgerhq/agent-intent-sdk": minor
---

Add the user's app rules for reviewing an intent: `intentReviewReducer` says what to do next in a review attempt (craft again once after a stale revision or an expired Solana craft, read the intent after an unclear submission), `intentLifecycleReducer` and `pollIntentLifecycle` follow the intent after the broadcast, with the status helpers and `createOwnSignatures`.
