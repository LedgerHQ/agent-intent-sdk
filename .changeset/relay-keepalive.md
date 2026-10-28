---
"@ledgerhq/agent-intent-sdk": patch
---

Keep enrollment and recovery channels open past the Trustchain relay's 5-minute
idle timeout. The relay dropped a host or candidate that went 5 minutes without
a frame sent to it, so a user who took longer to open the link or approve on the
device lost the session even though the signed request had not expired. Both
sides now send the relay a text `ping` every 60 seconds while the session is
open, and do not treat its `pong` replies as channel messages.

`host.close()` now ends the host session directly, stopping its timers and
pings and rejecting `waitForCompletion` with a "session has been closed" error,
instead of waiting for the socket to report that it closed.
