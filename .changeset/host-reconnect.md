---
"@ledgerhq/agent-intent-sdk": patch
---

The enrollment channel host reconnects after the Trustchain relay drops it, so a reviewer who leaves the enrollment page can come back and approve while the request is unexpired. The relay closes the host once its candidate leaves; the host now reopens on the same key, up to 5 times per enrollment, within the existing completion deadline. A reopened socket that fails before connecting is retried after 1, 2, 4 and 5 seconds. Error messages keep the "Enrollment relay closed before completion was acknowledged" prefix.
