---
"@ledgerhq/agent-intent-sdk": minor
---

Extend the controlled agent sources with `claude-code`, `codex`, `cursor`,
`muse`, `grok-bot`, and `other`, so an agent can declare the runtime it runs in.
`isAgentSource` now accepts any value, so untrusted input can be checked without
a separate string guard.
