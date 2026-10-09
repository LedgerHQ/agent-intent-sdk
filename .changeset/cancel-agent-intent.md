---
"@ledgerhq/agent-intent-sdk": minor
---

Add `AgentIntentClient.cancelIntent`, which cancels an intent the authenticated agent issued while it is `created` or `crafted` (`POST /v1/intents/{intentId}/cancel`). It resolves once the intent is cancelled, also when it already was. Any other state throws `AgentIntentHttpError` with status 400, and an unknown id or another agent's intent throws it with status 404. An empty, `.` or `..` id throws `AgentIntentSdkError` before any request.
