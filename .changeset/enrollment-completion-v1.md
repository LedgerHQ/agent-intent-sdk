---
"@ledgerhq/agent-intent-sdk": minor
---

The enrollment channel host accepts a version-1 completion (no account access) as well as a version-2 one, so an app can enroll an agent without sharing Ledger Sync account access. For an enrollment request, `AgentEnrollmentChannelCompletion` is now `AgentEnrollmentCompletion`: check `version === 2` before reading `accountAccess`. Hosts from earlier versions still refuse a version-1 completion.
