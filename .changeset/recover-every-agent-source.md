---
"@ledgerhq/agent-intent-sdk": minor
---

Let every supported agent source recover an existing identity. `SUPPORTED_AGENT_RECOVERY_SOURCES` is now `SUPPORTED_AGENT_SOURCES`, `AgentRecoverySource` is `AgentSource`, and `isAgentRecoverySource` delegates to `isAgentSource`, so `createAgentRecoveryRequest` and `validateAgentRecovery` accept `claude-code`, `codex`, `cursor`, `muse`, `grok-bot` and `other` as well as `openclaw` and `hermes`. Recovery never depended on the source: it is only a signed field. Values outside the controlled list are still rejected.
