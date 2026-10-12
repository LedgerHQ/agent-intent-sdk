---
"@ledgerhq/agent-intent-sdk": patch
---

In Node, requests to the Agent Intent BFF and to Keycloak / LKRP authentication now send `User-Agent: ledger-agent-intent-sdk/<version> (agentic)`, so agent traffic can be monitored on its own in Cloudflare and Datadog. Browsers keep their own User-Agent, so web apps using the SDK send no extra header and trigger no CORS preflight.
