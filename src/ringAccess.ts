import { AgentIntentSdkError, bytesToHex } from "./bytes.ts";
import {
  isAgentSource,
  type AgentEnrollmentChannelBinding,
  type AgentEnrollmentRequest,
  type AgentEnrollmentValidation,
  type AgentSource,
} from "./enrollment.ts";
import { SIGNATURE_COMPACT, sha256Digest, type AgentIdentity } from "./identity.ts";
import type { AgentRecoveryRequest } from "./recovery.ts";
import {
  checkRingAccessLink,
  hasAgentLinkHexLength,
  isEnrollmentEnvironment,
  malformedLink,
  malformedLinkMessage,
  verifyAgentLinkSignature,
  type AgentLinkIssue,
} from "./requestFields.ts";

export const AGENT_RING_ACCESS_VERSION = "4";
export const AGENT_RING_ACCESS_COMPLETION_VERSION = 4;

export type AgentRingAccessRequest = {
  version: typeof AGENT_RING_ACCESS_VERSION;
  publicKey: string;
  encryptionPublicKey: string;
  name: string;
  description: string;
  source: AgentSource;
  trustchainId: string;
  expiresAt: string;
  channel: AgentEnrollmentChannelBinding;
  signature: string;
};

export type AgentRingAccessRequestInput = {
  encryptionPublicKey: string;
  name: string;
  description: string;
  source: AgentSource;
  trustchainId: string;
  expiresAt: string;
  channel: AgentEnrollmentChannelBinding;
};

export type AgentRingAccessCompletion = {
  version: typeof AGENT_RING_ACCESS_COMPLETION_VERSION;
  agentPubkey: string;
  encryptionPublicKey: string;
  requestSignature: string;
  environment: "staging" | "production";
  trustchainId: string;
  applicationPath: string;
};

export type AgentRingAccessCompletionInput = Omit<AgentRingAccessCompletion, "version">;

export type AgentRingAccessValidation =
  | { status: "valid"; request: AgentRingAccessRequest }
  | Extract<AgentEnrollmentValidation, { status: "invalid" }>;

type UncheckedAgentRingAccessRequest = Omit<AgentRingAccessRequest, "source"> & { source: string };

const encoder = new TextEncoder();
const HARDENED_INDEX = /^(0|[1-9]\d*)'$/;
const HARDENED_OFFSET = 2 ** 31;
const COMPLETION_KEYS =
  "agentPubkey,applicationPath,encryptionPublicKey,environment,requestSignature,trustchainId,version";

export function isAgentRingAccessRequest(
  request: AgentEnrollmentRequest | AgentRecoveryRequest | AgentRingAccessRequest,
): request is AgentRingAccessRequest {
  return request.version === AGENT_RING_ACCESS_VERSION;
}

export function canonicalAgentRingAccessPayload(
  request: Omit<AgentRingAccessRequest, "signature">,
): Uint8Array {
  return encoder.encode(
    `agent-intent:agent-ring-access:v1\n${JSON.stringify({
      v: request.version,
      publicKey: request.publicKey.toLowerCase(),
      encryptionPublicKey: request.encryptionPublicKey.toLowerCase(),
      name: request.name,
      description: request.description,
      source: request.source,
      trustchainId: request.trustchainId,
      expiresAt: request.expiresAt,
      channelEnvironment: request.channel.environment,
      channelHost: request.channel.hostPublicKey.toLowerCase(),
    })}`,
  );
}

export function createAgentRingAccessRequest(
  identity: AgentIdentity,
  input: AgentRingAccessRequestInput,
): AgentRingAccessRequest {
  const unsigned: Omit<AgentRingAccessRequest, "signature"> = {
    version: AGENT_RING_ACCESS_VERSION,
    publicKey: identity.publicKey.toLowerCase(),
    encryptionPublicKey: input.encryptionPublicKey.toLowerCase(),
    name: input.name,
    description: input.description,
    source: input.source,
    trustchainId: input.trustchainId,
    expiresAt: input.expiresAt,
    channel: {
      environment: input.channel.environment,
      hostPublicKey: input.channel.hostPublicKey.toLowerCase(),
    },
  };
  assertRequestFields(unsigned);
  return {
    ...unsigned,
    signature: bytesToHex(
      identity.signDigest(
        sha256Digest(canonicalAgentRingAccessPayload(unsigned)),
        SIGNATURE_COMPACT,
      ),
    ),
  };
}

export function agentRingAccessSearch(request: AgentRingAccessRequest): Record<string, string> {
  return {
    v: request.version,
    publicKey: request.publicKey,
    encryptionPublicKey: request.encryptionPublicKey,
    name: request.name,
    description: request.description,
    source: request.source,
    trustchainId: request.trustchainId,
    expiresAt: request.expiresAt,
    channelEnvironment: request.channel.environment,
    channelHost: request.channel.hostPublicKey,
    signature: request.signature,
  };
}

export function createAgentRingAccessUrl(baseUrl: string, request: AgentRingAccessRequest): string {
  const url = new URL("/agents/ring-access", baseUrl);
  url.search = new URLSearchParams(agentRingAccessSearch(request)).toString();
  return url.toString();
}

export function validateAgentRingAccess(
  search: Record<string, unknown>,
  now = new Date(),
): AgentRingAccessValidation {
  const checked = checkRingAccessLink(search, AGENT_RING_ACCESS_VERSION);
  if ("issues" in checked) {
    return malformedLink(malformedLinkMessage("agent ring access", checked.issues), checked.issues);
  }
  const unchecked: UncheckedAgentRingAccessRequest = {
    version: AGENT_RING_ACCESS_VERSION,
    ...checked.fields,
  };
  const { source } = unchecked;
  if (!isAgentSource(source)) {
    return invalid("unsupported-source", "This agent source is not supported.");
  }
  const request: AgentRingAccessRequest = { ...unchecked, source };
  const expiration = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiration)) {
    const issues: [AgentLinkIssue] = [{ field: "expiresAt", problem: "invalid-value" }];
    return malformedLink(malformedLinkMessage("agent ring access", issues), issues);
  }
  if (expiration <= now.getTime()) {
    return invalid("expired", "This agent ring access link has expired.");
  }
  return verifyAgentLinkSignature(request, () => canonicalAgentRingAccessPayload(request))
    ? { status: "valid", request }
    : invalid(
        "invalid-signature",
        "This agent ring access link has been changed or is not authentic.",
      );
}

export function serializeAgentRingAccessCompletion(
  completion: AgentRingAccessCompletionInput,
): string {
  const ordered = orderedCompletion(completion);
  assertCompletionFields(ordered);
  return JSON.stringify(ordered, null, 2);
}

export function parseAgentRingAccessCompletion(
  payload: string,
  request: Pick<
    AgentRingAccessRequest,
    "publicKey" | "encryptionPublicKey" | "signature" | "trustchainId" | "channel"
  >,
): AgentRingAccessCompletion {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new AgentIntentSdkError("Agent ring access completion must be valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedCompletion();
  }
  const completion = value as Record<string, unknown>;
  const keys = Object.keys(completion).sort().join(",");
  if (completion.version !== AGENT_RING_ACCESS_COMPLETION_VERSION || keys !== COMPLETION_KEYS) {
    throw malformedCompletion();
  }
  const parsed = completion as AgentRingAccessCompletion;
  assertCompletionFields(parsed);
  if (parsed.agentPubkey.toLowerCase() !== request.publicKey.toLowerCase()) {
    throw new AgentIntentSdkError(
      "Agent ring access completion does not match the agent identity.",
    );
  }
  if (parsed.encryptionPublicKey.toLowerCase() !== request.encryptionPublicKey.toLowerCase()) {
    throw new AgentIntentSdkError(
      "Agent ring access completion does not match the requested encryption key.",
    );
  }
  if (parsed.requestSignature.toLowerCase() !== request.signature.toLowerCase()) {
    throw new AgentIntentSdkError(
      "Agent ring access completion does not match the pending signed ring access request.",
    );
  }
  if (parsed.trustchainId !== request.trustchainId) {
    throw new AgentIntentSdkError(
      "Agent ring access completion returned another Trustchain than the agent's.",
    );
  }
  if (parsed.environment !== request.channel.environment) {
    throw new AgentIntentSdkError(
      "Agent ring access completion returned another environment than the agent's.",
    );
  }
  return orderedCompletion({
    ...parsed,
    agentPubkey: parsed.agentPubkey.toLowerCase(),
    encryptionPublicKey: parsed.encryptionPublicKey.toLowerCase(),
    requestSignature: parsed.requestSignature.toLowerCase(),
  });
}

export function isKeyRingApplicationPath(path: string): boolean {
  const [root, purpose, application, ...indexes] = path.split("/");
  return (
    root === "m" &&
    purpose === "0'" &&
    application === "17'" &&
    (indexes.length === 1 || indexes.length === 3) &&
    indexes.every(isHardenedIndex)
  );
}

function isHardenedIndex(segment: string): boolean {
  const match = HARDENED_INDEX.exec(segment);
  return match !== null && Number(match[1]) < HARDENED_OFFSET;
}

function orderedCompletion(completion: AgentRingAccessCompletionInput): AgentRingAccessCompletion {
  return {
    version: AGENT_RING_ACCESS_COMPLETION_VERSION,
    agentPubkey: completion.agentPubkey,
    encryptionPublicKey: completion.encryptionPublicKey,
    requestSignature: completion.requestSignature,
    environment: completion.environment,
    trustchainId: completion.trustchainId,
    applicationPath: completion.applicationPath,
  };
}

function assertRequestFields(request: Omit<AgentRingAccessRequest, "signature">): void {
  // Also rejects unsupported sources passed by untyped JavaScript callers.
  const validation = validateAgentRingAccess(
    agentRingAccessSearch({ ...request, signature: "00".repeat(64) }),
  );
  if (validation.status === "invalid" && validation.reason !== "invalid-signature") {
    throw new AgentIntentSdkError(validation.message);
  }
}

function assertCompletionFields(completion: AgentRingAccessCompletion): void {
  if (
    !hasAgentLinkHexLength("publicKey", completion.agentPubkey) ||
    !hasAgentLinkHexLength("encryptionPublicKey", completion.encryptionPublicKey) ||
    !hasAgentLinkHexLength("signature", completion.requestSignature)
  ) {
    throw malformedCompletion();
  }
  if (
    !isEnrollmentEnvironment(completion.environment) ||
    typeof completion.trustchainId !== "string" ||
    completion.trustchainId === "" ||
    typeof completion.applicationPath !== "string" ||
    !isKeyRingApplicationPath(completion.applicationPath)
  ) {
    throw malformedCompletion();
  }
}

function malformedCompletion(): AgentIntentSdkError {
  return new AgentIntentSdkError("Agent ring access completion is malformed.");
}

function invalid(
  reason: Exclude<Extract<AgentRingAccessValidation, { status: "invalid" }>["reason"], "malformed">,
  message: string,
): AgentRingAccessValidation {
  return { status: "invalid", reason, message };
}
