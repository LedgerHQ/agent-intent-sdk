import { secp256k1 } from "@noble/curves/secp256k1.js";
import { AgentIntentSdkError, bytesToHex, hexToBytes } from "./bytes.ts";
import type {
  AgentEnrollmentChannelBinding,
  AgentEnrollmentValidation,
  AgentSource,
} from "./enrollment.ts";
import { SIGNATURE_COMPACT, sha256Digest, type AgentIdentity } from "./identity.ts";
import {
  isCompactSignature,
  isCompressedPublicKey,
  isEnrollmentEnvironment,
  isPublicKey,
  singleString,
} from "./requestFields.ts";

export const AGENT_RECOVERY_VERSION = "3";
export const AGENT_RECOVERY_COMPLETION_VERSION = 3;
/** Agent sources that may re-enroll an existing identity into its previous App-18 Trustchain. */
export const SUPPORTED_AGENT_RECOVERY_SOURCES = ["openclaw", "hermes"] as const;

/**
 * Signed request to re-enroll an existing agent key into its previous App-18
 * Trustchain. When `channel` is present it is covered by the signature and the
 * completion is delivered over the encrypted enrollment channel.
 */
export type AgentRecoveryRequest = {
  version: typeof AGENT_RECOVERY_VERSION;
  recovery: true;
  publicKey: string;
  name: string;
  description: string;
  source: AgentSource;
  previousTrustchainId: string;
  expiresAt: string;
  channel?: AgentEnrollmentChannelBinding;
  signature: string;
};

export type AgentRecoveryCompletion = {
  version: typeof AGENT_RECOVERY_COMPLETION_VERSION;
  recovery: true;
  agentPubkey: string;
  previousTrustchainId: string;
  requestSignature: string;
  trustchainId: string;
};

export type AgentRecoveryValidation =
  | { status: "valid"; request: AgentRecoveryRequest }
  | Extract<AgentEnrollmentValidation, { status: "invalid" }>;

const encoder = new TextEncoder();
const SEARCH_FIELDS = [
  "channelEnvironment",
  "channelHost",
  "description",
  "expiresAt",
  "name",
  "previousTrustchainId",
  "publicKey",
  "recovery",
  "signature",
  "source",
  "v",
];

export function isAgentRecoveryRequest(request: {
  version: string;
}): request is AgentRecoveryRequest {
  return request.version === AGENT_RECOVERY_VERSION;
}

export function canonicalAgentRecoveryPayload(
  request: Omit<AgentRecoveryRequest, "signature">,
): Uint8Array {
  return encoder.encode(
    `agent-intent:agent-recovery:v2\n${JSON.stringify({
      v: request.version,
      recovery: true,
      publicKey: request.publicKey.toLowerCase(),
      name: request.name,
      description: request.description,
      source: request.source,
      previousTrustchainId: request.previousTrustchainId,
      expiresAt: request.expiresAt,
      // Omitted from the JSON when absent so unbound recovery bytes stay unchanged.
      channelEnvironment: request.channel?.environment,
      channelHost: request.channel?.hostPublicKey.toLowerCase(),
    })}`,
  );
}

export function createAgentRecoveryRequest(
  identity: AgentIdentity,
  input: {
    name: string;
    description: string;
    source: AgentSource;
    previousTrustchainId: string;
    expiresAt: string;
    channel?: AgentEnrollmentChannelBinding;
  },
): AgentRecoveryRequest {
  const unsigned: Omit<AgentRecoveryRequest, "signature"> = {
    version: AGENT_RECOVERY_VERSION,
    recovery: true,
    publicKey: identity.publicKey.toLowerCase(),
    name: input.name,
    description: input.description,
    source: input.source,
    previousTrustchainId: input.previousTrustchainId,
    expiresAt: input.expiresAt,
    ...(input.channel === undefined
      ? {}
      : {
          channel: {
            environment: input.channel.environment,
            hostPublicKey: input.channel.hostPublicKey.toLowerCase(),
          },
        }),
  };
  assertRecoveryFields(unsigned);
  return {
    ...unsigned,
    signature: bytesToHex(
      identity.signDigest(sha256Digest(canonicalAgentRecoveryPayload(unsigned)), SIGNATURE_COMPACT),
    ),
  };
}

export function agentRecoverySearch(request: AgentRecoveryRequest): Record<string, string> {
  return {
    v: request.version,
    recovery: String(request.recovery),
    publicKey: request.publicKey,
    name: request.name,
    description: request.description,
    source: request.source,
    previousTrustchainId: request.previousTrustchainId,
    expiresAt: request.expiresAt,
    ...(request.channel === undefined
      ? {}
      : {
          channelEnvironment: request.channel.environment,
          channelHost: request.channel.hostPublicKey,
        }),
    signature: request.signature,
  };
}

export function createAgentRecoveryUrl(baseUrl: string, request: AgentRecoveryRequest): string {
  const url = new URL("/agents/new", baseUrl);
  url.search = new URLSearchParams(agentRecoverySearch(request)).toString();
  return url.toString();
}

export function validateAgentRecovery(
  search: Record<string, unknown>,
  now = new Date(),
): AgentRecoveryValidation {
  const request = recoveryRequestFromSearch(search);
  if (!request) {
    return invalid("malformed", "This agent recovery link is malformed or incomplete.");
  }
  if (!(SUPPORTED_AGENT_RECOVERY_SOURCES as readonly string[]).includes(request.source)) {
    return invalid("unsupported-source", "This agent source is not supported.");
  }
  const expiration = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiration)) {
    return invalid("malformed", "The agent recovery expiry is invalid.");
  }
  if (expiration <= now.getTime()) {
    return invalid("expired", "This agent recovery link has expired.");
  }
  try {
    const verified = secp256k1.verify(
      hexToBytes(request.signature),
      canonicalAgentRecoveryPayload(request),
      hexToBytes(request.publicKey),
      { prehash: true, lowS: false, format: "compact" },
    );
    return verified
      ? { status: "valid", request }
      : invalid(
          "invalid-signature",
          "This agent recovery link has been changed or is not authentic.",
        );
  } catch {
    return invalid(
      "invalid-signature",
      "This agent recovery link has been changed or is not authentic.",
    );
  }
}

export function serializeAgentRecoveryCompletion(
  completion: Omit<AgentRecoveryCompletion, "version" | "recovery">,
): string {
  assertCompletionFields(completion);
  return JSON.stringify(
    {
      version: AGENT_RECOVERY_COMPLETION_VERSION,
      recovery: true,
      agentPubkey: completion.agentPubkey,
      previousTrustchainId: completion.previousTrustchainId,
      requestSignature: completion.requestSignature,
      trustchainId: completion.trustchainId,
    },
    null,
    2,
  );
}

export function parseAgentRecoveryCompletion(
  payload: string,
  expectedAgentPubkey: string,
  expectedPreviousTrustchainId: string,
  expectedRequestSignature: string,
): AgentRecoveryCompletion {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new AgentIntentSdkError("Agent recovery completion must be valid JSON.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "agentPubkey,previousTrustchainId,recovery,requestSignature,trustchainId,version"
  ) {
    throw malformedCompletion();
  }
  const completion = value as Record<string, unknown>;
  if (
    completion.version !== AGENT_RECOVERY_COMPLETION_VERSION ||
    completion.recovery !== true ||
    typeof completion.agentPubkey !== "string" ||
    typeof completion.previousTrustchainId !== "string" ||
    typeof completion.requestSignature !== "string" ||
    typeof completion.trustchainId !== "string"
  ) {
    throw malformedCompletion();
  }
  assertCompletionFields(completion as Omit<AgentRecoveryCompletion, "version" | "recovery">);
  if (completion.agentPubkey.toLowerCase() !== expectedAgentPubkey.toLowerCase()) {
    throw new AgentIntentSdkError(
      "Agent recovery completion does not match the existing agent identity.",
    );
  }
  if (completion.previousTrustchainId !== expectedPreviousTrustchainId) {
    throw new AgentIntentSdkError(
      "Agent recovery completion does not match the profile's previous Trustchain.",
    );
  }
  if (completion.trustchainId !== expectedPreviousTrustchainId) {
    throw new AgentIntentSdkError("Agent recovery completion returned an unrelated Trustchain.");
  }
  if (completion.requestSignature.toLowerCase() !== expectedRequestSignature.toLowerCase()) {
    throw new AgentIntentSdkError(
      "Agent recovery completion does not match the pending signed recovery request.",
    );
  }
  return completion as AgentRecoveryCompletion;
}

function recoveryRequestFromSearch(
  search: Record<string, unknown>,
): AgentRecoveryRequest | undefined {
  if (Object.keys(search).some((key) => !SEARCH_FIELDS.includes(key))) return undefined;
  const v = singleString(search.v);
  const recovery = singleString(search.recovery);
  const publicKey = singleString(search.publicKey);
  const name = singleString(search.name);
  const description = singleString(search.description);
  const source = singleString(search.source);
  const previousTrustchainId = singleString(search.previousTrustchainId);
  const expiresAt = singleString(search.expiresAt);
  const channelEnvironment = singleString(search.channelEnvironment);
  const channelHost = singleString(search.channelHost);
  const signature = singleString(search.signature);
  const hasChannel = channelEnvironment !== undefined || channelHost !== undefined;
  if (
    v !== AGENT_RECOVERY_VERSION ||
    recovery !== "true" ||
    !publicKey ||
    !isPublicKey(publicKey) ||
    !name ||
    !name.trim() ||
    name.length > 80 ||
    !description ||
    !description.trim() ||
    description.length > 280 ||
    !source ||
    !previousTrustchainId ||
    !expiresAt ||
    !signature ||
    !isCompactSignature(signature) ||
    (hasChannel &&
      (!isEnrollmentEnvironment(channelEnvironment) || !isCompressedPublicKey(channelHost)))
  ) {
    return undefined;
  }
  return {
    version: v,
    recovery: true,
    publicKey: publicKey.toLowerCase(),
    name,
    description,
    source: source as AgentSource,
    previousTrustchainId,
    expiresAt,
    ...(hasChannel
      ? {
          channel: {
            environment: channelEnvironment as AgentEnrollmentChannelBinding["environment"],
            hostPublicKey: (channelHost as string).toLowerCase(),
          },
        }
      : {}),
    signature: signature.toLowerCase(),
  };
}

function assertRecoveryFields(request: Omit<AgentRecoveryRequest, "signature">): void {
  const validation = validateAgentRecovery(
    agentRecoverySearch({ ...request, signature: "00".repeat(64) }),
  );
  if (validation.status === "invalid" && validation.reason !== "invalid-signature") {
    throw new AgentIntentSdkError(validation.message);
  }
}

function assertCompletionFields(
  completion: Omit<AgentRecoveryCompletion, "version" | "recovery">,
): void {
  if (
    !completion.agentPubkey ||
    !completion.previousTrustchainId ||
    !completion.requestSignature ||
    !completion.trustchainId
  ) {
    throw malformedCompletion();
  }
}

function malformedCompletion(): AgentIntentSdkError {
  return new AgentIntentSdkError("Agent recovery completion is malformed.");
}

function invalid(
  reason: Extract<AgentRecoveryValidation, { status: "invalid" }>["reason"],
  message: string,
): AgentRecoveryValidation {
  return { status: "invalid", reason, message };
}
