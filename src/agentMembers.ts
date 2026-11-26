import { AgentIntentSdkError } from "./bytes.ts";
import { AGENT_NAME_MAX_LENGTH } from "./requestFields.ts";

export type AgentIntentTrustchainMember = { id: string; name: string; permissions: number };

const MEMBER_NAME_NAMESPACE = "agent-intent";
const MEMBER_NAME_VERSION = "v1";
// LKRP's identify-only `Permissions.MEMBER`, which App-18 gives every agent.
const AGENT_MEMBER_PERMISSIONS = 0;

export type ParsedBrowserMemberName = {
  version: typeof MEMBER_NAME_VERSION;
  kind: "browser";
  name: string;
};

export function encodeBrowserMemberName(name: string): string {
  return `${MEMBER_NAME_NAMESPACE}:${MEMBER_NAME_VERSION}:browser:${encodeDisplayName(name)}`;
}

export function encodeAgentMemberName(name: string): string {
  assertDisplayName(name);
  return name;
}

export function parseMemberName(value: string): ParsedBrowserMemberName | undefined {
  const segments = value.split(":");
  if (segments[0] !== MEMBER_NAME_NAMESPACE || segments[1] !== MEMBER_NAME_VERSION) {
    return undefined;
  }
  if (segments[2] === "browser" && segments.length === 4) {
    const name = decodeDisplayName(segments[3]);
    return name === undefined ? undefined : { version: MEMBER_NAME_VERSION, kind: "browser", name };
  }
  return undefined;
}

export function isBrowserMemberName(value: string): boolean {
  return parseMemberName(value)?.kind === "browser";
}

/** Permissions decide, whatever name the member was stored under (legacy encoded names included). */
export function parseAgentMember<Member extends Pick<AgentIntentTrustchainMember, "permissions">>(
  member: Member,
): { member: Member } | undefined {
  return member.permissions === AGENT_MEMBER_PERMISSIONS ? { member } : undefined;
}

function encodeDisplayName(name: string): string {
  assertDisplayName(name);
  try {
    return encodeURIComponent(name);
  } catch {
    // A lone surrogate, such as a name cut in the middle of an emoji.
    throw new AgentIntentSdkError("Trustchain member display name must be well-formed Unicode.");
  }
}

function decodeDisplayName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    if (!isValidDisplayName(decoded)) return undefined;
    // Refuse raw characters encodeURIComponent would escape, but accept lowercase escapes.
    return normalizeEscapes(encodeURIComponent(decoded)) === normalizeEscapes(value)
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function assertDisplayName(name: string): void {
  if (!isValidDisplayName(name)) {
    throw new AgentIntentSdkError(
      `Trustchain member display name must be nonempty and at most ${AGENT_NAME_MAX_LENGTH} characters.`,
    );
  }
}

function isValidDisplayName(value: string): boolean {
  return value.trim().length > 0 && value.length <= AGENT_NAME_MAX_LENGTH;
}

function normalizeEscapes(value: string): string {
  return value.replaceAll(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}
