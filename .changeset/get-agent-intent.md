---
"@ledgerhq/agent-intent-sdk": minor
---

Add `AgentIntentClient.getIntent`, which reads one intent the authenticated agent issued (`GET /v1/intents/{intentId}`) and returns an `AgentIntentRecord` with exact decimal-string amounts. An unknown id and another agent's intent both throw `AgentIntentHttpError` with status 404. Also exports `parseAgentIntentRecord`. An empty, `.` or `..` id throws `AgentIntentSdkError` before any request, since it would resolve to another endpoint.
