---
"@ledgerhq/agent-intent-sdk": minor
---

Add `reject()` to the enrollment channel candidate, so the frontend can tell
the agent that the user rejected an enrollment or recovery request instead of
leaving it to wait until the request expires. `reject()` connects first when
needed and, after key confirmation, sends the rejection the way a completion
travels, because the Trustchain relay refuses any message outside its own
protocol: a `TrustchainShareCredential` whose encrypted body is
`{ reason: "user-rejected" }`. It resolves once the host answers with a
`TrustchainAddedMember` whose encrypted body is
`{ reason: "rejection-acknowledged" }`. Only these bodies carry a `reason`, so
neither side takes a rejection for a completion or the reverse. Never call it
once the device has committed the enrollment to the Trustchain: it throws once
`deliver()` has been called, and the host refuses a rejection for good, with
`{ reason: "completion-received" }`, once it has received a well-formed
completion for the request. After any other failure `reject()` may be retried,
although the host may already have honored the rejection.

The host then ends its session for good: `waitForCompletion` rejects with the
new `AgentEnrollmentRejectedError`, whose `kind` is `"enrollment"` or
`"recovery"`, and the host does not reconnect. `isAgentEnrollmentRejectedError`
checks that error by shape, so it also matches an error from another realm or
another copy of the SDK. A rejection that does not decrypt, comes from another
key, or arrives before key confirmation never ends the host session: like any
unexpected frame, it only makes the host drop its current candidate. Anyone
who holds the signed link can complete key confirmation, and so can also reject
the request; the link already lets its holder reach the agent.

The host's refusals now reach the candidate. The relay accepts a `Failure` only
as `{ type, message }` with a `type` from its own list, so it refused the
host's encrypted `Failure` and closed both sides. The host now sends
`{ type: "UNEXPECTED_SHARE_CREDENTIAL", message: <ciphertext> }`, which the
relay forwards before it closes both sides, with the encrypted body
`{ reason: "reset" }` when it turns a completion down, instead of
`{ rejected: true }`. The candidate takes a `Failure` for the host's only when it
comes from the host key with that type and decrypts, and reads it before the
close that follows. Candidates from earlier versions read it as the relay's own
`Failure`, which fails that delivery just the same.

A host from an earlier version reads a rejection as a malformed completion, so
`reject()` fails and that host keeps waiting until its timeouts or the request
expiry. Bound `reject()` where the caller cannot wait.

`AgentEnrollmentChannelCandidate` gains the required `reject()` member, so code
that implements that type, such as a test double, must add it.
