import { secp256k1 } from "@noble/curves/secp256k1.js";
import { AgentIntentSdkError, bytesToHex, hexToBytes } from "./bytes.ts";
import {
  isAgentSource,
  SUPPORTED_AGENT_SOURCES,
  type AgentEnrollmentChannelBinding,
  type AgentEnrollmentRequest,
  type AgentEnrollmentValidation,
  type AgentSource,
} from "./enrollment.ts";
import { SIGNATURE_COMPACT, sha256Digest, type AgentIdentity } from "./identity.ts";
import {
  checkRecoveryLink,
  malformedLink,
  malformedLinkMessage,
  type AgentLinkIssue,
} from "./requestFields.ts";

export const AGENT_RECOVERY_VERSION = "3";
export const AGENT_RECOVERY_COMPLETION_VERSION = 3;
/**
 * Agent sources that may re-enroll an existing identity into its previous App-18 Trustchain: every
 * supported agent source. Recovery never depends on the source; it is only a signed field.
 */
export const SUPPORTED_AGENT_RECOVERY_SOURCES = SUPPORTED_AGENT_SOURCES;

/** Agent source that may sign a recovery request. */
export type AgentRecoverySource = AgentSource;

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
  source: AgentRecoverySource;
  previousTrustchainId: string;
  expiresAt: string;
  channel?: AgentEnrollmentChannelBinding;
  signature: string;
};

/** A recovery request whose signature binds an enrollment channel host. */
export type AgentRecoveryChannelRequest = AgentRecoveryRequest & {
  channel: AgentEnrollmentChannelBinding;
};

export type AgentRecoveryRequestInput = {
  name: string;
  description: string;
  source: AgentRecoverySource;
  previousTrustchainId: string;
  expiresAt: string;
  channel?: AgentEnrollmentChannelBinding;
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

/** Recovery request parsed from a URL whose `source` has not been narrowed yet. */
type UncheckedAgentRecoveryRequest = Omit<AgentRecoveryRequest, "source"> & { source: string };

const encoder = new TextEncoder();

export function isAgentRecoverySource(value: unknown): value is AgentRecoverySource {
  return isAgentSource(value);
}

export function isAgentRecoveryRequest(
  request: AgentEnrollmentRequest | AgentRecoveryRequest,
): request is AgentRecoveryRequest {
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
  input: AgentRecoveryRequestInput & { channel: AgentEnrollmentChannelBinding },
): AgentRecoveryChannelRequest;
export function createAgentRecoveryRequest(
  identity: AgentIdentity,
  input: AgentRecoveryRequestInput,
): AgentRecoveryRequest;
export function createAgentRecoveryRequest(
  identity: AgentIdentity,
  input: AgentRecoveryRequestInput,
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
  const checked = checkRecoveryLink(search, AGENT_RECOVERY_VERSION);
  if ("issues" in checked) {
    return malformedLink(malformedLinkMessage("agent recovery", checked.issues), checked.issues);
  }
  const unchecked: UncheckedAgentRecoveryRequest = {
    version: AGENT_RECOVERY_VERSION,
    recovery: true,
    ...checked.fields,
  };
  const { source } = unchecked;
  if (!isAgentRecoverySource(source)) {
    return invalid("unsupported-source", "This agent source is not supported.");
  }
  const request: AgentRecoveryRequest = { ...unchecked, source };
  const expiration = Date.parse(request.expiresAt);
  if (!Number.isFinite(expiration)) {
    const issues: [AgentLinkIssue] = [{ field: "expiresAt", problem: "invalid-value" }];
    return malformedLink(malformedLinkMessage("agent recovery", issues), issues);
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

function assertRecoveryFields(request: Omit<AgentRecoveryRequest, "signature">): void {
  // Also rejects unsupported sources passed by untyped JavaScript callers.
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
  reason: Exclude<Extract<AgentRecoveryValidation, { status: "invalid" }>["reason"], "malformed">,
  message: string,
): AgentRecoveryValidation {
  return { status: "invalid", reason, message };
}
