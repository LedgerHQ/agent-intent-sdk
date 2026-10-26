---
"@ledgerhq/agent-intent-sdk": patch
---

The enrollment channel host reconnects after the Trustchain relay drops it, so a reviewer who leaves the enrollment page can come back and approve while the request is unexpired. The relay closes the host once its candidate leaves; the host now reopens on the same key within the existing completion deadline. It stops after 5 reconnects in a row, and a socket that stayed open for at least 60 seconds resets that count. A reopened socket that fails before connecting is retried after 1, 2 and 4 seconds, then every 5 seconds, until reopening has failed for 60 seconds. A candidate that does not finish the handshake within `handshakeTimeoutMs` no longer fails the host; the host reopens and waits for another candidate. A host closed or timed out while a completion is being authenticated no longer persists that completion afterwards. Error messages keep the "Enrollment relay closed before completion was acknowledged" prefix.
