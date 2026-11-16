import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "./bytes.ts";

export const AGENT_NAME_MAX_LENGTH = 80;
export const AGENT_DESCRIPTION_MAX_LENGTH = 280;
const AGENT_LINK_HEX_LENGTHS = {
  publicKey: [66, 130],
  signature: [128],
  channelHost: [66],
  encryptionPublicKey: [66],
} as const;

const RECOVERY_LINK_FIELDS = [
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

const RING_ACCESS_LINK_FIELDS = [
  "v",
  "publicKey",
  "encryptionPublicKey",
  "name",
  "description",
  "source",
  "trustchainId",
  "expiresAt",
  "channelEnvironment",
  "channelHost",
  "signature",
] as const;

export type AgentLinkField =
  | (typeof RECOVERY_LINK_FIELDS)[number]
  | (typeof RING_ACCESS_LINK_FIELDS)[number];

type AgentLinkHexField = keyof typeof AGENT_LINK_HEX_LENGTHS;

export type AgentLinkIssue =
  | { field: AgentLinkField; problem: "missing" | "repeated" | "empty" | "invalid-value" }
  | { field: AgentLinkHexField; problem: "truncated" | "extra-characters"; expectedLength: number }
  | { field: "name" | "description"; problem: "too-long"; limit: number }
  | { field: "v"; problem: "unsupported-version" }
  | { problem: "unexpected"; parameter: string };

export type MalformedAgentLink = {
  status: "invalid";
  reason: "malformed";
  message: string;
  issues: AgentLinkIssues;
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

type AgentLinkChannel = NonNullable<AgentLinkFields["channel"]>;

type AgentLinkCheck<Fields> = { fields: Fields } | { issues: AgentLinkIssues };

type ChannelField = "channelEnvironment" | "channelHost";

const HEX = /^[0-9a-f]+$/i;
const HEX_OR_EMPTY = /^[0-9a-f]*$/i;
const NON_HEX = /[^0-9a-f]/i;
const ELLIPSIS = /…|\.{2,}/g;
const TRAILING_PUNCTUATION = /[\s.,;:!?'")\]}>]/;
const UNCOMPRESSED_PUBLIC_KEY_LENGTH = AGENT_LINK_HEX_LENGTHS.publicKey[1];
const CHANNEL_FIELDS: readonly ChannelField[] = ["channelEnvironment", "channelHost"];
const UNSUPPORTED_ENROLLMENT_FIELDS = ["permissions", "permission", "type"];
const COMPRESSED_KEY_FIELDS: readonly AgentLinkHexField[] = ["channelHost", "encryptionPublicKey"];

export function checkEnrollmentLink(
  search: Record<string, unknown>,
  versions: { standard: string; channel: string },
): AgentLinkCheck<AgentLinkFields> {
  const bound = search.v === versions.channel;
  const issues = linkIssues((rejected) => [
    versionIssue(search.v, [versions.standard, versions.channel]),
    ...metadataIssues(search),
    expiryIssue(search.expiresAt, rejected),
    ...(bound
      ? boundChannelIssues(search)
      : unboundChannelIssues(search, search.v === versions.standard, rejected)),
    hexIssue("signature", search.signature),
    ...UNSUPPORTED_ENROLLMENT_FIELDS.filter((field) => field in search).map(unexpected),
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
    ...unexpectedIssues(search, RECOVERY_LINK_FIELDS),
  ]);
  return linkCheck(issues, () => ({
    ...linkFields(search, bound),
    previousTrustchainId: search.previousTrustchainId as string,
  }));
}

export function checkRingAccessLink(
  search: Record<string, unknown>,
  version: string,
): AgentLinkCheck<
  Omit<AgentLinkFields, "channel"> & {
    encryptionPublicKey: string;
    trustchainId: string;
    channel: AgentLinkChannel;
  }
> {
  const issues = linkIssues((rejected) => [
    versionIssue(search.v, [version]),
    hexIssue("publicKey", search.publicKey),
    encryptionKeyIssue(search),
    ...agentDetailsIssues(search),
    presenceIssue("trustchainId", search.trustchainId),
    expiryIssue(search.expiresAt, rejected),
    ...boundChannelIssues(search),
    hexIssue("signature", search.signature),
    ...unexpectedIssues(search, RING_ACCESS_LINK_FIELDS),
  ]);
  return linkCheck(issues, () => ({
    ...linkFields(search, false),
    encryptionPublicKey: (search.encryptionPublicKey as string).toLowerCase(),
    trustchainId: search.trustchainId as string,
    channel: boundChannel(search),
  }));
}

export function hasAgentLinkHexLength(field: AgentLinkHexField, value: unknown): boolean {
  const lengths: readonly number[] = AGENT_LINK_HEX_LENGTHS[field];
  return typeof value === "string" && HEX.test(value) && lengths.includes(value.length);
}

export function verifyAgentLinkSignature(
  request: { signature: string; publicKey: string },
  canonicalPayload: () => Uint8Array,
): boolean {
  try {
    return secp256k1.verify(
      hexToBytes(request.signature),
      canonicalPayload(),
      hexToBytes(request.publicKey),
      {
        prehash: true,
        lowS: false,
        format: "compact",
      },
    );
  } catch {
    return false;
  }
}

export function malformedLink(message: string, issues: AgentLinkIssues): MalformedAgentLink {
  return { status: "invalid", reason: "malformed", message, issues };
}

export function malformedLinkMessage(link: string, [issue]: AgentLinkIssues): string {
  return `This ${link} link is malformed: ${describeIssue(issue)}.`;
}

export function isEnrollmentEnvironment(value: unknown): value is "staging" | "production" {
  return value === "staging" || value === "production";
}

function describeIssue(issue: AgentLinkIssue): string {
  if (issue.problem === "unexpected") return "it contains a parameter that is not supported";
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
    ...(bound ? { channel: boundChannel(search) } : {}),
  };
}

function boundChannel(search: Record<string, unknown>): AgentLinkChannel {
  return {
    environment: search.channelEnvironment as AgentLinkChannel["environment"],
    hostPublicKey: (search.channelHost as string).toLowerCase(),
  };
}

function metadataIssues(search: Record<string, unknown>): (AgentLinkIssue | undefined)[] {
  return [hexIssue("publicKey", search.publicKey), ...agentDetailsIssues(search)];
}

function agentDetailsIssues(search: Record<string, unknown>): (AgentLinkIssue | undefined)[] {
  return [
    textIssue("name", search.name, AGENT_NAME_MAX_LENGTH),
    textIssue("description", search.description, AGENT_DESCRIPTION_MAX_LENGTH),
    presenceIssue("source", search.source),
  ];
}

function encryptionKeyIssue(search: Record<string, unknown>): AgentLinkIssue | undefined {
  const issue = hexIssue("encryptionPublicKey", search.encryptionPublicKey);
  if (issue) return issue;
  // Key Ring access gets a dedicated key, so the App-18 signing key never becomes an App-17 member.
  const signingKey = compressedPublicKey(search.publicKey);
  return signingKey !== undefined &&
    signingKey === (search.encryptionPublicKey as string).toLowerCase()
    ? invalidValue("encryptionPublicKey")
    : undefined;
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
  if (hasAgentLinkHexLength(field, hex)) {
    return COMPRESSED_KEY_FIELDS.includes(field) && !isCompressedPublicKey(hex)
      ? invalidValue(field)
      : undefined;
  }
  if (
    COMPRESSED_KEY_FIELDS.includes(field) &&
    HEX.test(hex) &&
    hex.length === UNCOMPRESSED_PUBLIC_KEY_LENGTH
  ) {
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
  const digits = withoutTrailingPunctuation(hex.replace(ELLIPSIS, ""));
  if (!HEX_OR_EMPTY.test(digits)) return invalidValue(field);
  const problem = digits.length < expectedLength ? "truncated" : "extra-characters";
  return { field, problem, expectedLength };
}

function withoutTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.test(value.charAt(end - 1))) end--;
  return value.slice(0, end);
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

function unexpectedIssues(
  search: Record<string, unknown>,
  allowed: readonly AgentLinkField[],
): AgentLinkIssue[] {
  return Object.keys(search)
    .filter((key) => !(allowed as readonly string[]).includes(key))
    .map(unexpected);
}

function unexpected(parameter: string): AgentLinkIssue {
  return { problem: "unexpected", parameter };
}

function definedIssues(issues: (AgentLinkIssue | undefined)[]): AgentLinkIssue[] {
  return issues.filter((issue) => issue !== undefined);
}

function compressedPublicKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return secp256k1.Point.fromHex(value).toHex(true);
  } catch {
    return undefined;
  }
}

function isCompressedPublicKey(value: string): boolean {
  return compressedPublicKey(value) !== undefined;
}
