import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { AgentIntentSdkError, bytesToHex, concatBytes, hexToBytes } from "./bytes.ts";
import { parseAgentEnrollmentCompletion, type AgentEnrollmentCompletionV2 } from "./completion.ts";
import {
  AGENT_ENROLLMENT_CHANNEL_VERSION,
  agentEnrollmentSearch,
  canonicalAgentEnrollmentPayload,
  type AgentEnrollmentChannelBinding,
  type AgentEnrollmentRequestV2,
  validateAgentEnrollment,
} from "./enrollment.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";

const PROTOCOL_VERSION = 1;
const CHANNEL_DOMAIN = new TextEncoder().encode("agent-intent:enrollment-channel:v1");

type RelayMessageName =
  | "InitiateHandshake"
  | "HandshakeChallenge"
  | "CompleteHandshakeChallenge"
  | "HandshakeCompletionSucceeded"
  | "TrustchainShareCredential"
  | "TrustchainAddedMember"
  | "Failure";

type RelayEnvelope = {
  version: number;
  publisher: string;
  message: RelayMessageName;
  payload: Record<string, unknown>;
};

export type EnrollmentChannelWebSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
};

export type EnrollmentChannelWebSocketFactory = (url: string) => EnrollmentChannelWebSocket;

export type AgentEnrollmentChannelTimeouts = {
  candidateTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  completionTimeoutMs?: number;
  acknowledgementTimeoutMs?: number;
  persistTimeoutMs?: number;
};

export const AGENT_ENROLLMENT_CHANNEL_DEFAULT_TIMEOUTS = {
  candidateTimeoutMs: 15 * 60_000,
  handshakeTimeoutMs: 30_000,
  completionTimeoutMs: 15 * 60_000,
  acknowledgementTimeoutMs: 30_000,
  persistTimeoutMs: 30_000,
} as const satisfies Required<AgentEnrollmentChannelTimeouts>;

export type AgentEnrollmentChannelHost = {
  binding: AgentEnrollmentChannelBinding;
  waitForCompletion(input: {
    request: AgentEnrollmentRequestV2;
    authenticate: (completion: AgentEnrollmentCompletionV2) => Promise<void>;
    persist: (completion: AgentEnrollmentCompletionV2) => Promise<void>;
  }): Promise<AgentEnrollmentCompletionV2>;
  close(): void;
};

export type AgentEnrollmentChannelCandidate = {
  deliver(completionPayload: string): Promise<void>;
  close(): void;
};

export function createAgentEnrollmentChannelHost(input: {
  environment: AgentEnrollmentChannelBinding["environment"];
  relayBaseUrl: string;
  webSocketFactory?: EnrollmentChannelWebSocketFactory;
  timeouts?: AgentEnrollmentChannelTimeouts;
}): AgentEnrollmentChannelHost {
  const identity = createSoftwareAgentIdentity();
  const publisher = identity.publicKey;
  const timeouts = resolveTimeouts(input.timeouts);
  let used = false;
  let closed = false;
  let socket: EnrollmentChannelWebSocket | undefined;

  return {
    binding: { environment: input.environment, hostPublicKey: publisher },
    waitForCompletion: ({ request, authenticate, persist }) => {
      if (used) throw channelError("This enrollment host session has already been used.");
      if (closed) throw channelError("This enrollment host session has been closed.");
      if (typeof authenticate !== "function" || typeof persist !== "function") {
        throw channelError("Enrollment completion authentication and persistence are required.");
      }
      assertHostRequest(request, input.environment, publisher);
      used = true;
      try {
        socket = socketFactory(input.webSocketFactory)(relayUrl(input.relayBaseUrl, publisher));
      } catch (error) {
        return Promise.reject(asChannelError(error));
      }
      return runHost(socket, identity, request, authenticate, persist, timeouts);
    },
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}

export function createAgentEnrollmentChannelCandidate(input: {
  request: AgentEnrollmentRequestV2;
  relayBaseUrl: string;
  webSocketFactory?: EnrollmentChannelWebSocketFactory;
  now?: Date;
  timeouts?: AgentEnrollmentChannelTimeouts;
}): AgentEnrollmentChannelCandidate {
  assertCandidateRequest(input.request, input.now ?? new Date());

  const identity = createSoftwareAgentIdentity();
  const publisher = identity.publicKey;
  const timeouts = resolveTimeouts(input.timeouts);
  let used = false;
  let closed = false;
  let socket: EnrollmentChannelWebSocket | undefined;

  return {
    deliver: (completionPayload) => {
      if (used) throw channelError("This enrollment completion has already been sent.");
      if (closed) throw channelError("This enrollment completion channel has been closed.");
      assertCandidateRequest(input.request, new Date());
      used = true;
      try {
        socket = socketFactory(input.webSocketFactory)(
          relayUrl(input.relayBaseUrl, input.request.channel.hostPublicKey),
        );
      } catch (error) {
        return Promise.reject(asChannelError(error));
      }
      return runCandidate(socket, identity, publisher, input.request, completionPayload, timeouts);
    },
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}

function runHost(
  socket: EnrollmentChannelWebSocket,
  identity: ReturnType<typeof createSoftwareAgentIdentity>,
  request: AgentEnrollmentRequestV2,
  authenticate: (completion: AgentEnrollmentCompletionV2) => Promise<void>,
  persist: (completion: AgentEnrollmentCompletionV2) => Promise<void>,
  timeouts: Required<AgentEnrollmentChannelTimeouts>,
): Promise<AgentEnrollmentCompletionV2> {
  return new Promise((resolve, reject) => {
    let state:
      | "connected"
      | "challenged"
      | "authenticated"
      | "authenticating"
      | "persisting"
      | "finished" = "connected";
    let peer = "";
    let cipher: ChannelCipher | undefined;
    let challenge = "";
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    let messageQueue = Promise.resolve();

    const fail = failChannel(
      socket,
      reject,
      () => state === "finished",
      () => {
        state = "finished";
        clearTimeout(phaseTimer);
        clearTimeout(completionTimer);
      },
    );
    const armCandidateTimer = () => {
      clearTimeout(phaseTimer);
      phaseTimer = deadlineTimer(timeouts.candidateTimeoutMs, request.expiresAt, () =>
        fail(channelError("Enrollment channel timed out waiting for the frontend candidate.")),
      );
    };
    const armHandshakeTimer = () => {
      clearTimeout(phaseTimer);
      phaseTimer = deadlineTimer(timeouts.handshakeTimeoutMs, request.expiresAt, () =>
        fail(channelError("Enrollment channel handshake timed out.")),
      );
    };
    completionTimer = deadlineTimer(timeouts.completionTimeoutMs, request.expiresAt, () =>
      fail(channelError("Enrollment completion timed out.")),
    );
    const resetCandidate = () => {
      if (state === "finished") return;
      clearTimeout(phaseTimer);
      state = "connected";
      peer = "";
      cipher = undefined;
      challenge = "";
      armCandidateTimer();
    };
    const rejectCandidate = async (reason: unknown) => {
      const activeCipher = cipher;
      if (activeCipher) {
        try {
          await sendEncrypted(socket, identity.publicKey, "Failure", activeCipher, request, {
            rejected: true,
          });
        } catch {
          // The candidate is already unusable; keep the bounded host session available.
        }
      }
      resetCandidate();
      if (!(reason instanceof AgentIntentSdkError)) {
        // Normalize callback failures without exposing their potentially sensitive details.
        asChannelError(reason);
      }
    };
    armCandidateTimer();
    socket.addEventListener("error", () =>
      fail(channelError("Enrollment relay connection failed.")),
    );
    socket.addEventListener("close", () =>
      fail(channelError("Enrollment relay closed before completion was acknowledged.")),
    );
    socket.addEventListener("message", (event) => {
      messageQueue = messageQueue
        .then(async () => {
          const envelope = parseEnvelope(event.data);
          if (envelope.message === "Failure")
            throw channelError("The enrollment relay rejected the session.");

          if (state === "connected" && envelope.message === "InitiateHandshake") {
            const candidatePublicKey = stringField(envelope.payload, "ephemeral_public_key");
            if (candidatePublicKey.toLowerCase() !== envelope.publisher.toLowerCase()) {
              throw channelError("Enrollment channel publisher does not match its ephemeral key.");
            }
            peer = envelope.publisher.toLowerCase();
            state = "challenged";
            armHandshakeTimer();
            cipher = await makeCipher(
              identity.deriveSharedSecret(hexToBytes(candidatePublicKey)),
              request,
            );
            challenge = randomDigits(6);
            await sendEncrypted(socket, identity.publicKey, "HandshakeChallenge", cipher, request, {
              digits: challenge,
              connected: false,
            });
            return;
          }

          assertPeer(envelope, peer);
          if (state === "challenged" && envelope.message === "CompleteHandshakeChallenge") {
            const activeCipher = requireCipher(cipher);
            const answer = await decryptPayload(activeCipher, envelope, request);
            if (stringField(answer, "digits") !== challenge) {
              throw channelError("Enrollment channel key confirmation failed.");
            }
            await sendEncrypted(
              socket,
              identity.publicKey,
              "HandshakeCompletionSucceeded",
              activeCipher,
              request,
              {},
            );
            clearTimeout(phaseTimer);
            state = "authenticated";
            return;
          }

          if (state === "authenticated" && envelope.message === "TrustchainShareCredential") {
            state = "authenticating";
            const activeCipher = requireCipher(cipher);
            const payload = await decryptPayload(activeCipher, envelope, request);
            const serialized = stringField(payload, "completion");
            const completion = parseAgentEnrollmentCompletion(serialized, request.publicKey);
            if (completion.version !== 2) {
              throw channelError("The enrollment channel requires completion version 2.");
            }
            try {
              await withinDeadline(
                () => authenticate(completion),
                timeouts.persistTimeoutMs,
                request.expiresAt,
                "Enrollment completion authentication timed out.",
              );
            } catch (error) {
              await rejectCandidate(error);
              return;
            }
            state = "persisting";
            await withinDeadline(
              () => persist(completion),
              timeouts.persistTimeoutMs,
              request.expiresAt,
              "Enrollment completion persistence timed out.",
            );
            await sendEncrypted(
              socket,
              identity.publicKey,
              "TrustchainAddedMember",
              activeCipher,
              request,
              {
                acknowledged: true,
                digest: completionDigest(serialized),
              },
            );
            state = "finished";
            clearTimeout(completionTimer);
            clearTimeout(phaseTimer);
            socket.close();
            resolve(completion);
            return;
          }

          throw channelError(`Unexpected ${envelope.message} enrollment channel message.`);
        })
        .catch(async (error) => {
          if (state === "persisting" || state === "finished") {
            fail(error);
            return;
          }
          await rejectCandidate(error);
        });
    });
  });
}

function runCandidate(
  socket: EnrollmentChannelWebSocket,
  identity: ReturnType<typeof createSoftwareAgentIdentity>,
  publisher: string,
  request: AgentEnrollmentRequestV2,
  completionPayload: string,
  timeouts: Required<AgentEnrollmentChannelTimeouts>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let state: "connecting" | "initiated" | "confirmed" | "sent" | "finished" = "connecting";
    let cipher: ChannelCipher | undefined;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let messageQueue = Promise.resolve();

    const fail = failChannel(
      socket,
      reject,
      () => state === "finished",
      () => {
        state = "finished";
        clearTimeout(phaseTimer);
        clearTimeout(completionTimer);
      },
    );
    const completionTimer = deadlineTimer(timeouts.completionTimeoutMs, request.expiresAt, () =>
      fail(channelError("Enrollment completion delivery timed out.")),
    );
    phaseTimer = deadlineTimer(timeouts.handshakeTimeoutMs, request.expiresAt, () =>
      fail(channelError("Enrollment channel handshake timed out.")),
    );
    socket.addEventListener("error", () =>
      fail(channelError("Enrollment relay connection failed.")),
    );
    socket.addEventListener("close", () =>
      fail(channelError("Enrollment relay closed before completion was acknowledged.")),
    );
    socket.addEventListener("open", () => {
      if (state !== "connecting") return;
      try {
        send(socket, {
          version: PROTOCOL_VERSION,
          publisher,
          message: "InitiateHandshake",
          payload: { ephemeral_public_key: publisher },
        });
        state = "initiated";
      } catch (error) {
        fail(error);
      }
    });
    socket.addEventListener("message", (event) => {
      messageQueue = messageQueue
        .then(async () => {
          const envelope = parseEnvelope(event.data);
          if (envelope.publisher.toLowerCase() !== request.channel.hostPublicKey.toLowerCase()) {
            throw channelError("Enrollment channel host does not match the signed request.");
          }
          if (envelope.message === "Failure") {
            if (cipher && "encrypted" in envelope.payload) {
              await decryptPayload(cipher, envelope, request);
              throw channelError("The enrollment host rejected this completion.");
            }
            throw channelError("The enrollment relay rejected the session.");
          }

          if (state === "initiated" && envelope.message === "HandshakeChallenge") {
            cipher = await makeCipher(
              identity.deriveSharedSecret(hexToBytes(request.channel.hostPublicKey)),
              request,
            );
            const challenge = await decryptPayload(cipher, envelope, request);
            await sendEncrypted(socket, publisher, "CompleteHandshakeChallenge", cipher, request, {
              digits: stringField(challenge, "digits"),
            });
            state = "confirmed";
            return;
          }

          if (state === "confirmed" && envelope.message === "HandshakeCompletionSucceeded") {
            const activeCipher = requireCipher(cipher);
            await decryptPayload(activeCipher, envelope, request);
            await sendEncrypted(
              socket,
              publisher,
              "TrustchainShareCredential",
              activeCipher,
              request,
              {
                completion: completionPayload,
              },
            );
            clearTimeout(phaseTimer);
            phaseTimer = deadlineTimer(timeouts.acknowledgementTimeoutMs, request.expiresAt, () =>
              fail(channelError("Enrollment completion acknowledgement timed out.")),
            );
            state = "sent";
            return;
          }

          if (state === "sent" && envelope.message === "TrustchainAddedMember") {
            const acknowledgement = await decryptPayload(cipher, envelope, request);
            if (
              acknowledgement.acknowledged !== true ||
              stringField(acknowledgement, "digest") !== completionDigest(completionPayload)
            ) {
              throw channelError("Enrollment completion acknowledgement is invalid.");
            }
            state = "finished";
            clearTimeout(phaseTimer);
            clearTimeout(completionTimer);
            socket.close();
            resolve();
            return;
          }

          throw channelError(`Unexpected ${envelope.message} enrollment channel message.`);
        })
        .catch(fail);
    });
  });
}

type ChannelCipher = {
  key: CryptoKey;
  requestDigest: Uint8Array;
};

async function makeCipher(
  sharedSecret: Uint8Array,
  request: AgentEnrollmentRequestV2,
): Promise<ChannelCipher> {
  const requestDigest = signedRequestDigest(request);
  const keyBytes = deriveChannelKeyBytes(sharedSecret, requestDigest);
  return {
    key: await crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]),
    requestDigest,
  };
}

async function encryptPayload(
  cipher: ChannelCipher,
  envelope: Pick<RelayEnvelope, "version" | "publisher" | "message">,
  value: object,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(12)),
): Promise<string> {
  if (nonce.length !== 12) throw channelError("Enrollment channel nonce must be 12 bytes.");
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(envelopeAad(envelope, cipher.requestDigest)),
      },
      cipher.key,
      plaintext,
    ),
  );
  return bytesToBase64(concatBytes(nonce, encrypted));
}

async function decryptPayload(
  cipher: ChannelCipher | undefined,
  envelope: RelayEnvelope,
  request: AgentEnrollmentRequestV2,
): Promise<Record<string, unknown>> {
  if (!cipher) throw channelError("Enrollment channel encryption is not initialized.");
  if (!constantTimeEqual(cipher.requestDigest, signedRequestDigest(request))) {
    throw channelError("Enrollment channel request binding changed.");
  }
  if (
    Object.keys(envelope.payload).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(envelope.payload, "encrypted")
  ) {
    throw channelError("Enrollment channel encrypted envelope is malformed.");
  }
  const encoded = stringField(envelope.payload, "encrypted");
  const blob = base64ToBytes(encoded);
  if (blob.length <= 28) throw channelError("Enrollment channel payload is malformed.");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.slice(0, 12),
        additionalData: toArrayBuffer(envelopeAad(envelope, cipher.requestDigest)),
      },
      cipher.key,
      blob.slice(12),
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw channelError("Enrollment channel payload could not be authenticated.");
  }
}

async function sendEncrypted(
  socket: EnrollmentChannelWebSocket,
  publisher: string,
  message: Exclude<RelayMessageName, "InitiateHandshake">,
  cipher: ChannelCipher,
  request: AgentEnrollmentRequestV2,
  payload: object,
): Promise<void> {
  if (!constantTimeEqual(cipher.requestDigest, signedRequestDigest(request))) {
    throw channelError("Enrollment channel request binding changed.");
  }
  const metadata = {
    version: PROTOCOL_VERSION,
    publisher: publisher.toLowerCase(),
    message,
  } as const;
  const encrypted = await encryptPayload(cipher, metadata, payload);
  send(socket, {
    ...metadata,
    payload: { encrypted },
  });
}

function send(socket: EnrollmentChannelWebSocket, envelope: RelayEnvelope): void {
  socket.send(JSON.stringify(envelope));
}

function parseEnvelope(data: unknown): RelayEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    throw channelError("Enrollment relay returned invalid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw channelError("Enrollment relay returned an invalid message.");
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== PROTOCOL_VERSION ||
    typeof envelope.publisher !== "string" ||
    !isRelayMessageName(envelope.message) ||
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    Array.isArray(envelope.payload)
  ) {
    throw channelError("Enrollment relay returned an invalid message.");
  }
  return envelope as RelayEnvelope;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw channelError(`Enrollment channel ${field} is missing.`);
  }
  return result;
}

function isRelayMessageName(value: unknown): value is RelayMessageName {
  return [
    "InitiateHandshake",
    "HandshakeChallenge",
    "CompleteHandshakeChallenge",
    "HandshakeCompletionSucceeded",
    "TrustchainShareCredential",
    "TrustchainAddedMember",
    "Failure",
  ].includes(String(value));
}

function assertPeer(envelope: RelayEnvelope, expected: string): void {
  if (!expected || envelope.publisher.toLowerCase() !== expected) {
    throw channelError("Enrollment channel peer changed during the session.");
  }
}

function requireCipher(cipher: ChannelCipher | undefined): ChannelCipher {
  if (!cipher) throw channelError("Enrollment channel encryption is not initialized.");
  return cipher;
}

function relayUrl(baseUrl: string, hostPublicKey: string): string {
  const url = new URL("/v1/qr", baseUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw channelError("Enrollment relay must use an HTTP or HTTPS base URL.");
  url.searchParams.set("host", hostPublicKey);
  return url.toString();
}

function socketFactory(
  factory: EnrollmentChannelWebSocketFactory | undefined,
): EnrollmentChannelWebSocketFactory {
  if (factory) return factory;
  if (typeof WebSocket === "undefined") {
    throw channelError("This runtime does not provide WebSocket support.");
  }
  return (url) => new WebSocket(url);
}

function completionDigest(payload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(payload)));
}

function signedRequestDigest(request: AgentEnrollmentRequestV2): Uint8Array {
  return sha256(
    concatBytes(
      canonicalAgentEnrollmentPayload(request),
      new Uint8Array([0]),
      hexToBytes(request.signature),
    ),
  );
}

function deriveChannelKeyBytes(sharedSecret: Uint8Array, requestDigest: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, requestDigest, CHANNEL_DOMAIN, 32);
}

function envelopeAad(
  envelope: Pick<RelayEnvelope, "version" | "publisher" | "message">,
  requestDigest: Uint8Array,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      domain: "agent-intent:enrollment-channel:aad:v1",
      requestDigest: bytesToHex(requestDigest),
      version: envelope.version,
      publisher: envelope.publisher,
      message: envelope.message,
    }),
  );
}

function randomDigits(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => byte % 10).join("");
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw channelError("Enrollment channel payload is not valid base64.");
  }
}

function failChannel(
  socket: EnrollmentChannelWebSocket,
  reject: (reason: unknown) => void,
  finished: () => boolean,
  beforeReject: () => void,
): (reason: unknown) => void {
  let failed = false;
  return (reason) => {
    if (failed || finished()) return;
    failed = true;
    beforeReject();
    socket.close();
    reject(asChannelError(reason));
  };
}

function assertHostRequest(
  request: AgentEnrollmentRequestV2,
  environment: AgentEnrollmentChannelBinding["environment"],
  hostPublicKey: string,
): void {
  assertCandidateRequest(request, new Date());
  if (
    request.channel.environment !== environment ||
    request.channel.hostPublicKey.toLowerCase() !== hostPublicKey.toLowerCase()
  ) {
    throw channelError("The signed enrollment request does not belong to this host.");
  }
}

function assertCandidateRequest(request: AgentEnrollmentRequestV2, now: Date): void {
  if (request.version !== AGENT_ENROLLMENT_CHANNEL_VERSION) {
    throw channelError("Automatic completion requires an enrollment channel request.");
  }
  const validation = validateAgentEnrollment(agentEnrollmentSearch(request), now);
  if (validation.status === "invalid") {
    throw channelError(
      validation.reason === "expired"
        ? "The enrollment channel has expired."
        : "The enrollment channel request is not authentic.",
    );
  }
}

function resolveTimeouts(
  timeouts: AgentEnrollmentChannelTimeouts | undefined,
): Required<AgentEnrollmentChannelTimeouts> {
  const resolved = { ...AGENT_ENROLLMENT_CHANNEL_DEFAULT_TIMEOUTS, ...timeouts };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw channelError(`${name} must be a positive integer number of milliseconds.`);
    }
  }
  return resolved;
}

function deadlineTimer(
  timeoutMs: number,
  expiresAt: string,
  onTimeout: () => void,
): ReturnType<typeof setTimeout> {
  const remaining = Date.parse(expiresAt) - Date.now();
  return setTimeout(onTimeout, Math.max(0, Math.min(timeoutMs, remaining)));
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  expiresAt: string,
  message: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = deadlineTimer(timeoutMs, expiresAt, () => reject(channelError(message)));
    void Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

/** @internal Protocol-vector helpers. Not exported from the package root. */
export const enrollmentChannelCryptoVectors = {
  signedRequestDigest: (request: AgentEnrollmentRequestV2): string =>
    bytesToHex(signedRequestDigest(request)),
  deriveKey: (sharedSecret: Uint8Array, request: AgentEnrollmentRequestV2): string =>
    bytesToHex(deriveChannelKeyBytes(sharedSecret, signedRequestDigest(request))),
  aad: (
    request: AgentEnrollmentRequestV2,
    envelope: Pick<RelayEnvelope, "version" | "publisher" | "message">,
  ): string => new TextDecoder().decode(envelopeAad(envelope, signedRequestDigest(request))),
  encrypt: async (
    sharedSecret: Uint8Array,
    request: AgentEnrollmentRequestV2,
    envelope: Pick<RelayEnvelope, "version" | "publisher" | "message">,
    payload: object,
    nonce: Uint8Array,
  ): Promise<string> => {
    const cipher = await makeCipher(sharedSecret, request);
    return encryptPayload(cipher, envelope, payload, nonce);
  },
};

function asChannelError(reason: unknown): AgentIntentSdkError {
  return reason instanceof AgentIntentSdkError
    ? reason
    : channelError(reason instanceof Error ? reason.message : "Enrollment channel failed.");
}

function channelError(message: string): AgentIntentSdkError {
  return new AgentIntentSdkError(message);
}
