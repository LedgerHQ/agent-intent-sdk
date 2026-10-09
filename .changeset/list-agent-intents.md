---
"@ledgerhq/agent-intent-sdk": minor
---

Add `AgentIntentClient.listIntents`, which lists the intents the authenticated agent issued, most recent first, with optional `status` filters, `pageSize` and an opaque `nextCursor` for pagination. It returns `AgentIntentPage` / `AgentIntentRecord`, keeps every amount as an exact decimal string, and exports `AGENT_INTENT_STATUSES`, `AGENT_INTENT_PAGE_SIZES`, `isAgentIntentStatus`, `isAgentIntentPageSize` and `parseAgentIntentPage`. An unsupported `status` or `pageSize` throws `AgentIntentSdkError` before any request, and a listing that is not valid JSON or has an unexpected shape (including mistyped optional fields) throws `AgentIntentSdkError`. `AgentIntentSdkError` now accepts a `cause`.
