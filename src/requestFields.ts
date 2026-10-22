import { secp256k1 } from "@noble/curves/secp256k1.js";

export const AGENT_NAME_MAX_LENGTH = 80;
export const AGENT_DESCRIPTION_MAX_LENGTH = 280;
export const AGENT_LINK_HEX_LENGTHS = Object.freeze({
  publicKey: Object.freeze([66, 130] as const),
  signature: Object.freeze([128] as const),
  channelHost: Object.freeze([66] as const),
});

const AGENT_LINK_FIELDS = [
  "v",
  "recovery",
  "publicKey",
  "name",
  "description",
  "source",
  "previousTrustchainId",
  "expiresAt",
  "channelEnvironment",
  "channelHost",
  "signature",
] as const;

export type AgentLinkField = (typeof AGENT_LINK_FIELDS)[number];

export type AgentLinkHexField = keyof typeof AGENT_LINK_HEX_LENGTHS;

export type AgentLinkIssue =
  | { field: AgentLinkField; problem: "missing" | "repeated" | "empty" | "invalid-value" }
  | { field: AgentLinkHexField; problem: "truncated" | "extra-characters"; expectedLength: number }
  | { field: "name" | "description"; problem: "too-long"; limit: number }
  | { field: "v"; problem: "unsupported-version" }
  | { field: string; problem: "unexpected" };

export type MalformedAgentLink = {
  status: "invalid";
  reason: "malformed";
  message: string;
  issues: AgentLinkIssue[];
};

type AgentLinkIssues = [AgentLinkIssue, ...AgentLinkIssue[]];

type AgentLinkFields = {
  publicKey: string;
  name: string;
  description: string;
  source: string;
  expiresAt: string;
  signature: string;
  channel?: { environment: "staging" | "production"; hostPublicKey: string };
};

type AgentLinkCheck<Fields> = { fields: Fields } | { issues: AgentLinkIssues };

type ChannelField = "channelEnvironment" | "channelHost";

const HEX = /^[0-9a-f]+$/i;
const HEX_OR_EMPTY = /^[0-9a-f]*$/i;
const NON_HEX = /[^0-9a-f]/i;
const ELLIPSIS = /…|\.{2,}/g;
const TRAILING_PUNCTUATION = /[\s.,;:!?'")\]}>]+$/;
const UNCOMPRESSED_PUBLIC_KEY_LENGTH = AGENT_LINK_HEX_LENGTHS.publicKey[1];
const CHANNEL_FIELDS: readonly ChannelField[] = ["channelEnvironment", "channelHost"];
const UNSUPPORTED_ENROLLMENT_FIELDS = ["permissions", "permission", "type"];

export function checkEnrollmentLink(
  search: Record<string, unknown>,
  versions: { standard: string; channel: string },
): AgentLinkCheck<AgentLinkFields> {
  const bound = search.v === versions.channel;
  const issues = linkIssues((rejected) => [
    ...UNSUPPORTED_ENROLLMENT_FIELDS.filter((field) => field in search).map(unexpected),
    versionIssue(search.v, [versions.standard, versions.channel]),
    ...metadataIssues(search),
    expiryIssue(search.expiresAt, rejected),
    ...(bound
      ? boundChannelIssues(search)
      : unboundChannelIssues(search, search.v === versions.standard, rejected)),
    hexIssue("signature", search.signature),
  ]);
  return linkCheck(issues, () => linkFields(search, bound));
}

export function checkRecoveryLink(
  search: Record<string, unknown>,
  version: string,
): AgentLinkCheck<AgentLinkFields & { previousTrustchainId: string }> {
  const bound = CHANNEL_FIELDS.some((field) => typeof search[field] === "string");
  const issues = linkIssues((rejected) => [
    versionIssue(search.v, [version]),
    presenceIssue("recovery", search.recovery) ??
      (search.recovery === "true" ? undefined : invalidValue("recovery")),
    ...metadataIssues(search),
    presenceIssue("previousTrustchainId", search.previousTrustchainId),
    expiryIssue(search.expiresAt, rejected),
    ...(bound ? boundChannelIssues(search) : unboundChannelIssues(search, false, rejected)),
    hexIssue("signature", search.signature),
    ...Object.keys(search)
      .filter((key) => !(AGENT_LINK_FIELDS as readonly string[]).includes(key))
      .map(unexpected),
  ]);
  return linkCheck(issues, () => ({
    ...linkFields(search, bound),
    previousTrustchainId: search.previousTrustchainId as string,
  }));
}

export function malformedLink(message: string, issues: AgentLinkIssue[]): MalformedAgentLink {
  return { status: "invalid", reason: "malformed", message, issues };
}

export function malformedLinkMessage(link: string, [issue]: AgentLinkIssues): string {
  return `This ${link} link is malformed: ${describeIssue(issue)}.`;
}

export function isEnrollmentEnvironment(value: unknown): value is "staging" | "production" {
  return value === "staging" || value === "production";
}

function describeIssue(issue: AgentLinkIssue): string {
  const field = `"${issue.field}"`;
  switch (issue.problem) {
    case "missing":
      return `${field} is missing`;
    case "repeated":
      return `${field} appears more than once`;
    case "empty":
      return `${field} is empty`;
    case "invalid-value":
      return `${field} has an invalid value`;
    case "truncated":
      return `${field} is cut off (expected ${issue.expectedLength} hex characters)`;
    case "extra-characters":
      return `${field} has extra characters (expected ${issue.expectedLength} hex characters)`;
    case "too-long":
      return `${field} is longer than ${issue.limit} characters`;
    case "unsupported-version":
      return "its version is not supported";
    case "unexpected":
      return "it contains a parameter that is not supported";
  }
}

function linkIssues(
  collect: (rejected: boolean) => (AgentLinkIssue | undefined)[],
): AgentLinkIssue[] {
  const issues = definedIssues(collect(false));
  return issues.length === 0 ? issues : definedIssues(collect(true));
}

function linkCheck<Fields>(issues: AgentLinkIssue[], fields: () => Fields): AgentLinkCheck<Fields> {
  const [first, ...rest] = issues;
  return first === undefined ? { fields: fields() } : { issues: [first, ...rest] };
}

function linkFields(search: Record<string, unknown>, bound: boolean): AgentLinkFields {
  const text = (field: AgentLinkField) => search[field] as string;
  return {
    publicKey: text("publicKey").toLowerCase(),
    name: text("name"),
    description: text("description"),
    source: text("source"),
    expiresAt: text("expiresAt"),
    signature: text("signature").toLowerCase(),
    ...(bound
      ? {
          channel: {
            environment: text("channelEnvironment") as "staging" | "production",
            hostPublicKey: text("channelHost").toLowerCase(),
          },
        }
      : {}),
  };
}

function metadataIssues(search: Record<string, unknown>): (AgentLinkIssue | undefined)[] {
  return [
    hexIssue("publicKey", search.publicKey),
    textIssue("name", search.name, AGENT_NAME_MAX_LENGTH),
    textIssue("description", search.description, AGENT_DESCRIPTION_MAX_LENGTH),
    presenceIssue("source", search.source),
  ];
}

function presenceIssue(field: AgentLinkField, value: unknown): AgentLinkIssue | undefined {
  if (value === undefined) return { field, problem: "missing" };
  if (Array.isArray(value)) return { field, problem: "repeated" };
  if (typeof value !== "string") return invalidValue(field);
  if (value === "") return { field, problem: "empty" };
  return undefined;
}

function versionIssue(value: unknown, versions: readonly unknown[]): AgentLinkIssue | undefined {
  return (
    presenceIssue("v", value) ??
    (versions.includes(value) ? undefined : { field: "v", problem: "unsupported-version" })
  );
}

function expiryIssue(value: unknown, rejected: boolean): AgentLinkIssue | undefined {
  return (
    presenceIssue("expiresAt", value) ??
    (rejected && !Number.isFinite(Date.parse(value as string))
      ? invalidValue("expiresAt")
      : undefined)
  );
}

function textIssue(
  field: "name" | "description",
  value: unknown,
  limit: number,
): AgentLinkIssue | undefined {
  const presence = presenceIssue(field, value);
  if (presence) return presence;
  const text = value as string;
  if (text.trim().length === 0) return { field, problem: "empty" };
  if (text.length > limit) return { field, problem: "too-long", limit };
  return undefined;
}

function hexIssue(field: AgentLinkHexField, value: unknown): AgentLinkIssue | undefined {
  const presence = presenceIssue(field, value);
  if (presence) return presence;
  const hex = value as string;
  const lengths: readonly number[] = AGENT_LINK_HEX_LENGTHS[field];
  if (HEX.test(hex) && lengths.includes(hex.length)) {
    return field === "channelHost" && !isCompressedPublicKey(hex) ? invalidValue(field) : undefined;
  }
  if (field === "channelHost" && HEX.test(hex) && hex.length === UNCOMPRESSED_PUBLIC_KEY_LENGTH) {
    return invalidValue(field);
  }
  const expectedLength =
    field === "publicKey" && hex.startsWith("04")
      ? UNCOMPRESSED_PUBLIC_KEY_LENGTH
      : AGENT_LINK_HEX_LENGTHS[field][0];
  const firstNonHex = hex.search(NON_HEX);
  if ((firstNonHex === -1 ? hex.length : firstNonHex) >= expectedLength) {
    return { field, problem: "extra-characters", expectedLength };
  }
  const digits = hex.replace(ELLIPSIS, "").replace(TRAILING_PUNCTUATION, "");
  if (!HEX_OR_EMPTY.test(digits)) return invalidValue(field);
  const problem = digits.length < expectedLength ? "truncated" : "extra-characters";
  return { field, problem, expectedLength };
}

function boundChannelIssues(search: Record<string, unknown>): (AgentLinkIssue | undefined)[] {
  return [
    presenceIssue("channelEnvironment", search.channelEnvironment) ??
      (isEnrollmentEnvironment(search.channelEnvironment)
        ? undefined
        : invalidValue("channelEnvironment")),
    hexIssue("channelHost", search.channelHost),
  ];
}

function unboundChannelIssues(
  search: Record<string, unknown>,
  textIsUnexpected: boolean,
  rejected: boolean,
): (AgentLinkIssue | undefined)[] {
  return CHANNEL_FIELDS.map((field) => {
    if (textIsUnexpected && typeof search[field] === "string") return unexpected(field);
    if (rejected && Array.isArray(search[field])) return { field, problem: "repeated" };
    return undefined;
  });
}

function invalidValue(field: AgentLinkField): AgentLinkIssue {
  return { field, problem: "invalid-value" };
}

function unexpected(field: string): AgentLinkIssue {
  return { field, problem: "unexpected" };
}

function definedIssues(issues: (AgentLinkIssue | undefined)[]): AgentLinkIssue[] {
  return issues.filter((issue) => issue !== undefined);
}

function isCompressedPublicKey(value: string): boolean {
  try {
    secp256k1.Point.fromHex(value);
    return true;
  } catch {
    return false;
  }
}
