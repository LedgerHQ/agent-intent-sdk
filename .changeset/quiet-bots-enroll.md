---
"@ledgerhq/agent-intent-sdk": minor
---

Add signed version-2 enrollment requests and a request-bound, authenticated,
timeout-bounded completion channel over the Trustchain QR relay. The host now
authenticates completions before durable persistence and acknowledgement while
preserving manual recovery and allowing a separate 15-minute window for
device-approved enrollment before the 30-second cryptographic handshake.
