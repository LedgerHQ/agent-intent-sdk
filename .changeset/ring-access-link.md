---
"@ledgerhq/agent-intent-sdk": minor
---

Add the Key Ring access link: `createAgentRingAccessRequest`, `createAgentRingAccessUrl`, `validateAgentRingAccess`, `isAgentRingAccessRequest`, `serializeAgentRingAccessCompletion`, `parseAgentRingAccessCompletion`, `isKeyRingApplicationPath`, and the `"ring-access"` kind of `AgentEnrollmentRejectedError` (`AgentEnrollmentRejectionKind`).

Breaking for consumers of channel requests and link fields: a ring access request has every field of a version-2 enrollment request, so code that treats `!isAgentRecoveryRequest(request)` as an enrollment must now check `isAgentRingAccessRequest(request)` first, and `AgentLinkField` gains `encryptionPublicKey` and `trustchainId`, so a `Record<AgentLinkField, …>` needs entries for both. Code that switches on `AgentEnrollmentRejectedError.kind` must handle `"ring-access"`. Recovery links still refuse the two new parameters.
