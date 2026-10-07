---
"@ledgerhq/agent-intent-sdk": minor
---

Add `AgentIntentClient.listIntents`, which lists the intents the authenticated agent issued, most recent first, with optional `status` filters, `pageSize` and an opaque `nextCursor` for pagination. It returns `AgentIntentPage` / `AgentIntentRecord`, keeps every amount as an exact decimal string (also when an older BFF sends JSON numbers), and exports `AGENT_INTENT_STATUSES`, `AGENT_INTENT_PAGE_SIZES`, `isAgentIntentStatus`, `isAgentIntentPageSize` and `parseAgentIntentPage`.
