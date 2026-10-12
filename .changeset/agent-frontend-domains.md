---
"@ledgerhq/agent-intent-sdk": patch
---

Fix Agent Intent frontend links to use the new hosts: `https://app.agents.ledger-test.com/` for staging and `https://app.agents.ledger.com/` for production. Enrollment and recovery links and intent deeplinks returned by the BFF now point at these hosts.
