import { secp256k1 } from "@noble/curves/secp256k1.js";
import { AgentIntentSdkError, bytesToHex, hexToBytes } from "./bytes.ts";
import { SIGNATURE_COMPACT, sha256Digest, type AgentIdentity } from "./identity.ts";

export const AGENT_ENROLLMENT_VERSION = "1";
export const SUPPORTED_AGENT_SOURCES = ["openclaw", "hermes"] as const;

export type AgentSource = (typeof SUPPORTED_AGENT_SOURCES)[number];

export type AgentEnrollmentRequest = {
  version: typeof AGENT_ENROLLMENT_VERSION;
  publicKey: string;
  name: string;
  description: string;
  source: AgentSource;
  expiresAt: string;
  signature: string;
};

export type AgentEnrollmentValidation =
  | { status: "valid"; request: AgentEnrollmentRequest }
  | {
      status: "invalid";
      reason: "expired" | "invalid-signature" | "malformed" | "unsupported-source";
      message: string;
    };

const encoder = new TextEncoder();
const HEX = /^[0-9a-f]+$/i;

export function isAgentSource(value: string): value is AgentSource {
  return (SUPPORTED_AGENT_SOURCES as readonly string[]).includes(value);
}

export function canonicalAgentEnrollmentPayload(
  request: Omit<AgentEnrollmentRequest, "signature">,
): Uint8Array {
  const payload = JSON.stringify({
    v: request.version,
    publicKey: request.publicKey.toLowerCase(),
    name: request.name,
    description: request.description,
    source: request.source,
    expiresAt: request.expiresAt,
  });
  return encoder.encode(`agent-intent:agent-enrollment:v1\n${payload}`);
}

export function createAgentEnrollmentRequest(
  identity: AgentIdentity,
  input: {
    name: string;
    description: string;
    source: AgentSource;
    expiresAt: string;
  },
): AgentEnrollmentRequest {
  const unsigned: Omit<AgentEnrollmentRequest, "signature"> = {
    version: AGENT_ENROLLMENT_VERSION,
    publicKey: identity.publicKey.toLowerCase(),
    name: input.name,
    description: input.description,
    source: input.source,
    expiresAt: input.expiresAt,
  };
  assertEnrollmentFields(unsigned);
  const signature = bytesToHex(
    identity.signDigest(sha256Digest(canonicalAgentEnrollmentPayload(unsigned)), SIGNATURE_COMPACT),
  );
  return { ...unsigned, signature };
}

export function agentEnrollmentSearch(request: AgentEnrollmentRequest): Record<string, string> {
  return {
    v: request.version,
    publicKey: request.publicKey,
    name: request.name,
    description: request.description,
    source: request.source,
    expiresAt: request.expiresAt,
    signature: request.signature,
  };
}

export function createAgentEnrollmentUrl(baseUrl: string, request: AgentEnrollmentRequest): string {
  const url = new URL("/agents/new", baseUrl);
  url.search = new URLSearchParams(agentEnrollmentSearch(request)).toString();
  return url.toString();
}

export function validateAgentEnrollment(
  search: Record<string, unknown>,
  now = new Date(),
): AgentEnrollmentValidation {
  if ("permissions" in search || "permission" in search || "type" in search) {
    return invalid("malformed", "This enrollment link contains an unsupported field.");
  }

  const v = singleString(search.v);
  const publicKey = singleString(search.publicKey);
  const name = singleString(search.name);
  const description = singleString(search.description);
  const source = singleString(search.source);
  const expiresAt = singleString(search.expiresAt);
  const signature = singleString(search.signature);

  if (
    v !== AGENT_ENROLLMENT_VERSION ||
    !publicKey ||
    !name ||
    name.trim().length === 0 ||
    name.length > 80 ||
    !description ||
    description.trim().length === 0 ||
    description.length > 280 ||
    !source ||
    !expiresAt ||
    !signature ||
    !isPublicKey(publicKey) ||
    !isCompactSignature(signature)
  ) {
    return invalid("malformed", "This agent enrollment link is malformed or incomplete.");
  }
  if (!isAgentSource(source)) {
    return invalid("unsupported-source", "This agent source is not supported.");
  }
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration)) {
    return invalid("malformed", "The enrollment expiry is invalid.");
  }
  if (expiration <= now.getTime()) {
    return invalid("expired", "This agent enrollment link has expired.");
  }

  const request: AgentEnrollmentRequest = {
    version: v,
    publicKey: publicKey.toLowerCase(),
    name,
    description,
    source,
    expiresAt,
    signature: signature.toLowerCase(),
  };
  try {
    const verified = secp256k1.verify(
      hexToBytes(request.signature),
      canonicalAgentEnrollmentPayload(request),
      hexToBytes(request.publicKey),
      { prehash: true, lowS: false, format: "compact" },
    );
    return verified
      ? { status: "valid", request }
      : invalid("invalid-signature", "This enrollment link has been changed or is not authentic.");
  } catch {
    return invalid(
      "invalid-signature",
      "This enrollment link has been changed or is not authentic.",
    );
  }
}

function assertEnrollmentFields(request: Omit<AgentEnrollmentRequest, "signature">): void {
  const validation = validateAgentEnrollment({
    ...agentEnrollmentSearch({ ...request, signature: "00".repeat(64) }),
  });
  if (validation.status === "invalid" && validation.reason !== "invalid-signature") {
    throw new AgentIntentSdkError(validation.message);
  }
}

function singleString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isPublicKey(value: string): boolean {
  return (value.length === 66 || value.length === 130) && HEX.test(value);
}

function isCompactSignature(value: string): boolean {
  return value.length === 128 && HEX.test(value);
}

function invalid(
  reason: Extract<AgentEnrollmentValidation, { status: "invalid" }>["reason"],
  message: string,
): AgentEnrollmentValidation {
  return { status: "invalid", reason, message };
}
