---
"@ledgerhq/agent-intent-sdk": minor
---

Split the enrollment channel candidate into `connect()` and `deliver()`, so a
frontend can reach the agent before device approval and deliver afterwards on
the same session. `deliver()` still connects implicitly. A failed delivery can now
be retried on the same candidate, on a fresh session with a new ephemeral key.

Move the agent recovery request and version-3 recovery completion format into
the SDK (`createAgentRecoveryRequest`, `validateAgentRecovery`,
`serializeAgentRecoveryCompletion`, `parseAgentRecoveryCompletion`, and
related helpers). Recovery request `source` is typed as `AgentRecoverySource`
(`openclaw` or `hermes`), with an `isAgentRecoverySource` guard. Recovery requests can carry a signed channel binding
(`createAgentRecoveryRequest` returns an `AgentRecoveryChannelRequest` when given
a channel), and the channel host accepts a recovery completion for a recovery
request.
