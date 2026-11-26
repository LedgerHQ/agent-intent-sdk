import { AgentIntentSdkError } from "./bytes.ts";
import { AGENT_NAME_MAX_LENGTH } from "./requestFields.ts";

export type AgentIntentTrustchainMember = { id: string; name: string; permissions: number };

const MEMBER_NAME_NAMESPACE = "agent-intent";
const MEMBER_NAME_VERSION = "v1";
// LKRP's identify-only `Permissions.MEMBER`, which App-18 gives every agent.
const AGENT_MEMBER_PERMISSIONS = 0;
// LKRP writes each TLV length in one byte, and an AddMember command holds 43 bytes besides the name.
const MEMBER_NAME_MAX_BYTES = 212;

export function encodeBrowserMemberName(name: string): string {
  assertDisplayName(name);
  return storableMemberName(
    `${MEMBER_NAME_NAMESPACE}:${MEMBER_NAME_VERSION}:browser:${encodeURIComponent(name)}`,
  );
}

export function encodeAgentMemberName(name: string): string {
  assertDisplayName(name);
  return storableMemberName(name);
}

export function isAgentMember(member: Pick<AgentIntentTrustchainMember, "permissions">): boolean {
  return member.permissions === AGENT_MEMBER_PERMISSIONS;
}

export function normalizeAgentKey(pubkey: string): string {
  return pubkey.toLowerCase();
}

function assertDisplayName(name: string): void {
  if (name.trim().length === 0 || name.length > AGENT_NAME_MAX_LENGTH) {
    throw new AgentIntentSdkError(
      `Trustchain member display name must be nonempty and at most ${AGENT_NAME_MAX_LENGTH} characters.`,
    );
  }
  // LKRP would store a lone surrogate, such as a name cut in the middle of an emoji, as U+FFFD.
  if (/\p{Surrogate}/u.test(name)) {
    throw new AgentIntentSdkError("Trustchain member display name must be well-formed Unicode.");
  }
}

function storableMemberName(memberName: string): string {
  if (new TextEncoder().encode(memberName).length > MEMBER_NAME_MAX_BYTES) {
    throw new AgentIntentSdkError(
      `Trustchain member name must be at most ${MEMBER_NAME_MAX_BYTES} bytes in UTF-8.`,
    );
  }
  return memberName;
}
