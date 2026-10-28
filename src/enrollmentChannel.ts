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
import {
  agentRecoverySearch,
  canonicalAgentRecoveryPayload,
  isAgentRecoveryRequest,
  parseAgentRecoveryCompletion,
  validateAgentRecovery,
  type AgentRecoveryChannelRequest,
  type AgentRecoveryCompletion,
  type AgentRecoveryRequest,
} from "./recovery.ts";

const PROTOCOL_VERSION = 1;
const CHANNEL_DOMAIN = new TextEncoder().encode("agent-intent:enrollment-channel:v1");

// The Trustchain relay drops a client after 5 minutes without a frame sent to it. Its own
// WebSocket heartbeats and pong replies do not count, but it answers a text "ping" with a
// text "pong" to the sender only, so each side sends one well inside that window.
const RELAY_KEEPALIVE_INTERVAL_MS = 60_000;
const RELAY_KEEPALIVE_PING = "ping";
const RELAY_KEEPALIVE_PONG = "pong";
// A socket can stay half-open without reporting close; the host treats a ping that gets no
// frame back within this window as a drop.
const RELAY_PONG_TIMEOUT_MS = 10_000;

// The relay closes the host socket once its candidate leaves. The host reopens on the same key
// until the request expires or the completion timeout elapses: at once, then after 1, 2 and 4
// seconds, then every 5 seconds. A socket that stayed open for a minute before it dropped
// restarts that backoff; the minute is measured on the monotonic clock, so a wall-clock change
// does not move it.
const HOST_RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000] as const;
const HOST_RECONNECT_MAX_DELAY_MS = 5_000;
const HOST_RECONNECT_STABLE_MS = 60_000;

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

/** Signed requests whose completion can be delivered over the enrollment channel. */
export type AgentEnrollmentChannelRequest = AgentEnrollmentRequestV2 | AgentRecoveryChannelRequest;

/** Completion accepted by the host for a given channel request kind. */
export type AgentEnrollmentChannelCompletion<
  Request extends AgentEnrollmentChannelRequest = AgentEnrollmentChannelRequest,
> = Request extends AgentRecoveryRequest ? AgentRecoveryCompletion : AgentEnrollmentCompletionV2;

export type AgentEnrollmentChannelHost = {
  binding: AgentEnrollmentChannelBinding;
  waitForCompletion<Request extends AgentEnrollmentChannelRequest>(input: {
    request: Request;
    authenticate: (completion: AgentEnrollmentChannelCompletion<Request>) => Promise<void>;
    persist: (completion: AgentEnrollmentChannelCompletion<Request>) => Promise<void>;
  }): Promise<AgentEnrollmentChannelCompletion<Request>>;
  close(): void;
};

export type AgentEnrollmentChannelCandidate = {
  /**
   * Opens the relay session and completes the key-confirmation handshake, then
   * keeps the session open for a later `deliver()`. Resolves once the host is
   * reachable. Repeated calls share the open session.
   */
  connect(): Promise<void>;
  /**
   * Sends the serialized completion and resolves once the host acknowledges it.
   * Connects first when no session is open. After a rejection the candidate may
   * retry on a fresh session while the signed request is unexpired.
   */
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
  let session: HostSession | undefined;

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
      const openSocket = () =>
        socketFactory(input.webSocketFactory)(relayUrl(input.relayBaseUrl, publisher));
      let socket: EnrollmentChannelWebSocket;
      try {
        socket = openSocket();
      } catch (error) {
        return Promise.reject(asChannelError(error));
      }
      session = runHost(
        socket,
        openSocket,
        identity,
        request,
        authenticate as (completion: AgentEnrollmentChannelCompletion) => Promise<void>,
        persist as (completion: AgentEnrollmentChannelCompletion) => Promise<void>,
        timeouts,
      );
      return session.completion as Promise<AgentEnrollmentChannelCompletion<typeof request>>;
    },
    close: () => {
      closed = true;
      session?.close();
    },
  };
}

export function createAgentEnrollmentChannelCandidate(input: {
  request: AgentEnrollmentChannelRequest;
  relayBaseUrl: string;
  webSocketFactory?: EnrollmentChannelWebSocketFactory;
  now?: Date;
  timeouts?: AgentEnrollmentChannelTimeouts;
}): AgentEnrollmentChannelCandidate {
  assertCandidateRequest(input.request, input.now ?? new Date());

  const timeouts = resolveTimeouts(input.timeouts);
  let session: CandidateSession | undefined;
  let delivering = false;
  let delivered = false;
  let closed = false;

  const assertUsable = () => {
    if (delivered) throw channelError("This enrollment completion has already been sent.");
    if (closed) throw channelError("This enrollment completion channel has been closed.");
    assertCandidateRequest(input.request, new Date());
  };
  const connectSession = (): Promise<CandidateSession> => {
    if (session === undefined || session.failed) {
      try {
        session = openCandidateSession(
          socketFactory(input.webSocketFactory)(
            relayUrl(input.relayBaseUrl, input.request.channel.hostPublicKey),
          ),
          input.request,
          timeouts,
        );
      } catch (error) {
        return Promise.reject(asChannelError(error));
      }
    }
    const active = session;
    return active.ready.then(() => active);
  };

  return {
    connect: () => {
      assertUsable();
      return connectSession().then(() => undefined);
    },
    deliver: (completionPayload) => {
      if (delivering) throw channelError("This enrollment completion is already being sent.");
      assertUsable();
      delivering = true;
      return connectSession()
        .then((active) => active.deliver(completionPayload))
        .then(() => {
          delivered = true;
        })
        .finally(() => {
          delivering = false;
        });
    },
    close: () => {
      closed = true;
      session?.close();
    },
  };
}

type HostSession = {
  readonly completion: Promise<AgentEnrollmentChannelCompletion>;
  close(): void;
};

function runHost(
  initialSocket: EnrollmentChannelWebSocket,
  openSocket: () => EnrollmentChannelWebSocket,
  identity: ReturnType<typeof createSoftwareAgentIdentity>,
  request: AgentEnrollmentChannelRequest,
  authenticate: (completion: AgentEnrollmentChannelCompletion) => Promise<void>,
  persist: (completion: AgentEnrollmentChannelCompletion) => Promise<void>,
  timeouts: Required<AgentEnrollmentChannelTimeouts>,
): HostSession {
  let close: () => void = () => undefined;
  const completion = new Promise<AgentEnrollmentChannelCompletion>((resolve, reject) => {
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
    let stopKeepAlive: () => void = () => undefined;
    let messageQueue = Promise.resolve();
    let socket = initialSocket;
    // Set once the session resolves or fails; a handler resuming after an await can still
    // move `state`, so reconnects and timers check this instead.
    let settled = false;
    let attempts = 0;
    let loseSocket: (message: string) => void = () => undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = failChannel(
      () => socket.close(),
      reject,
      () => settled,
      () => {
        settled = true;
        state = "finished";
        clearTimeout(phaseTimer);
        clearTimeout(completionTimer);
        clearTimeout(reconnectTimer);
        stopKeepAlive();
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
      // A candidate that stops answering is dropped like a relay drop, so another can connect.
      // The lost path runs directly because some sockets never report their own close.
      phaseTimer = deadlineTimer(timeouts.handshakeTimeoutMs, request.expiresAt, () =>
        loseSocket("Enrollment channel handshake timed out."),
      );
    };
    completionTimer = deadlineTimer(timeouts.completionTimeoutMs, request.expiresAt, () =>
      fail(channelError("Enrollment completion timed out.")),
    );
    const resetCandidate = () => {
      if (settled) return;
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
    // Stops timers and keepalive itself rather than relying on the socket's close event.
    close = () => fail(channelError("This enrollment host session has been closed."));
    armCandidateTimer();
    const openReconnect = () => {
      if (settled) return;
      // Timers stop while a laptop sleeps, so the wall clock decides whether the request expired.
      if (Date.parse(request.expiresAt) <= Date.now()) {
        fail(channelError("Enrollment completion timed out."));
        return;
      }
      let source: EnrollmentChannelWebSocket | undefined;
      try {
        source = openSocket();
        attach(source, true);
      } catch {
        // A factory or socket that throws is retried like a failed open; the queue must not reject.
        try {
          source?.close();
        } catch {
          // The socket was never attached, so nothing reports its failure.
        }
        reconnect();
      }
    };
    const reconnect = () => {
      if (settled) return;
      // A drop before any candidate keeps the running wait for the first one.
      if (state !== "connected") resetCandidate();
      const delay = HOST_RECONNECT_DELAYS_MS[attempts] ?? HOST_RECONNECT_MAX_DELAY_MS;
      attempts += 1;
      // The relay rejects a candidate that arrives while the host is away, so the first
      // reopen does not wait for a timer.
      if (delay === 0) openReconnect();
      else reconnectTimer = setTimeout(openReconnect, delay);
    };
    const attach = (source: EnrollmentChannelWebSocket, reopened: boolean) => {
      let opened = false;
      let openedAt = 0;
      let lost = false;
      const onLost = (message: string) => {
        if (lost || source !== socket || settled) return;
        lost = true;
        stopKeepAlive();
        // A socket that only reported an error may still be open, and the relay keeps its
        // candidate until it closes.
        try {
          source.close();
        } catch {
          // A socket that cannot close is already gone.
        }
        if ((!opened && !reopened) || state === "authenticating" || state === "persisting") {
          fail(channelError(message));
          return;
        }
        if (opened && performance.now() - openedAt >= HOST_RECONNECT_STABLE_MS) attempts = 0;
        // Queued so a handler already running for this socket finishes before the reset.
        messageQueue = messageQueue.then(reconnect);
      };
      source.addEventListener("open", () => {
        opened = true;
        openedAt = performance.now();
        if (source === socket && !settled && !lost) {
          stopKeepAlive = keepRelayAlive(source, () =>
            onLost("Enrollment relay closed before completion was acknowledged."),
          );
        }
      });
      source.addEventListener("error", () => onLost("Enrollment relay connection failed."));
      source.addEventListener("close", () =>
        onLost("Enrollment relay closed before completion was acknowledged."),
      );
      source.addEventListener("message", (event) => {
        if (source === socket && !isRelayKeepAliveReply(event.data)) {
          handleMessage(event.data, () => lost);
        }
      });
      socket = source;
      loseSocket = onLost;
    };
    const handleMessage = (data: unknown, lost: () => boolean) => {
      messageQueue = messageQueue
        .then(async () => {
          // A frame queued before the relay dropped its socket would answer a candidate that left.
          if (lost() || settled) return;
          const envelope = parseEnvelope(data);
          if (envelope.message === "Failure")
            throw channelError("The enrollment relay rejected the session.");

          // The relay admits one candidate per host socket and closes the host when it leaves,
          // which attach() handles by reopening. A relay that admits another candidate before
          // delivery still gets a fresh handshake here.
          if (
            envelope.message === "InitiateHandshake" &&
            (state === "connected" || state === "challenged" || state === "authenticated")
          ) {
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
            if (settled) return;
            clearTimeout(phaseTimer);
            state = "authenticated";
            return;
          }

          if (state === "authenticated" && envelope.message === "TrustchainShareCredential") {
            state = "authenticating";
            const activeCipher = requireCipher(cipher);
            const payload = await decryptPayload(activeCipher, envelope, request);
            const serialized = stringField(payload, "completion");
            const completion = parseChannelCompletion(serialized, request);
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
            if (settled) return;
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
            settled = true;
            state = "finished";
            clearTimeout(completionTimer);
            clearTimeout(phaseTimer);
            stopKeepAlive();
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
    };
    attach(initialSocket, false);
  });
  return { completion, close: () => close() };
}

type CandidateSession = {
  /** Settles once the handshake completes or the session fails. */
  readonly ready: Promise<void>;
  readonly failed: boolean;
  deliver(completionPayload: string): Promise<void>;
  close(): void;
};

function openCandidateSession(
  socket: EnrollmentChannelWebSocket,
  request: AgentEnrollmentChannelRequest,
  timeouts: Required<AgentEnrollmentChannelTimeouts>,
): CandidateSession {
  // Each session uses its own ephemeral key so a reconnect never shares a channel key.
  const identity = createSoftwareAgentIdentity();
  const publisher = identity.publicKey;
  let state: "connecting" | "initiated" | "confirmed" | "ready" | "sent" | "finished" | "failed" =
    "connecting";
  let cipher: ChannelCipher | undefined;
  let failure: AgentIntentSdkError | undefined;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let stopKeepAlive: () => void = () => undefined;
  let messageQueue = Promise.resolve();
  let delivery:
    | { digest: string; resolve: () => void; reject: (reason: unknown) => void }
    | undefined;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (reason: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Callers observe failures through connect()/deliver(); an idle session must not leak a rejection.
  ready.catch(() => undefined);

  const fail = failChannel(
    () => socket.close(),
    (error) => {
      failure = asChannelError(error);
      rejectReady(failure);
      delivery?.reject(failure);
    },
    () => state === "finished",
    () => {
      state = "failed";
      clearTimeout(phaseTimer);
      clearTimeout(sessionTimer);
      stopKeepAlive();
    },
  );
  // Bounds the whole session, including the device-approval gap between connect() and deliver().
  const sessionTimer = deadlineTimer(timeouts.completionTimeoutMs, request.expiresAt, () =>
    fail(channelError("Enrollment completion delivery timed out.")),
  );
  phaseTimer = deadlineTimer(timeouts.handshakeTimeoutMs, request.expiresAt, () =>
    fail(channelError("Enrollment channel handshake timed out.")),
  );
  socket.addEventListener("error", () => fail(channelError("Enrollment relay connection failed.")));
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
      stopKeepAlive = keepRelayAlive(socket);
    } catch (error) {
      fail(error);
    }
  });
  socket.addEventListener("message", (event) => {
    if (isRelayKeepAliveReply(event.data)) return;
    messageQueue = messageQueue
      .then(async () => {
        const envelope = parseEnvelope(event.data);
        // The relay's own Failure is unencrypted and does not carry the host key as publisher.
        if (envelope.message === "Failure" && !("encrypted" in envelope.payload)) {
          throw channelError("The enrollment relay rejected the session.");
        }
        if (envelope.publisher.toLowerCase() !== request.channel.hostPublicKey.toLowerCase()) {
          throw channelError("Enrollment channel host does not match the signed request.");
        }
        if (envelope.message === "Failure") {
          if (cipher && "encrypted" in envelope.payload) {
            await decryptPayload(cipher, envelope, request);
            throw channelError(
              state === "sent"
                ? "The enrollment host rejected this completion."
                : "The enrollment host reset this session.",
            );
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
          await decryptPayload(requireCipher(cipher), envelope, request);
          clearTimeout(phaseTimer);
          state = "ready";
          resolveReady();
          return;
        }

        if (state === "sent" && envelope.message === "TrustchainAddedMember") {
          const acknowledgement = await decryptPayload(cipher, envelope, request);
          if (
            acknowledgement.acknowledged !== true ||
            stringField(acknowledgement, "digest") !== delivery?.digest
          ) {
            throw channelError("Enrollment completion acknowledgement is invalid.");
          }
          state = "finished";
          clearTimeout(phaseTimer);
          clearTimeout(sessionTimer);
          stopKeepAlive();
          socket.close();
          delivery.resolve();
          return;
        }

        throw channelError(`Unexpected ${envelope.message} enrollment channel message.`);
      })
      .catch(fail);
  });

  return {
    ready,
    get failed() {
      return state === "failed";
    },
    deliver: (completionPayload) =>
      new Promise<void>((resolve, reject) => {
        if (state !== "ready") {
          reject(failure ?? channelError("Enrollment channel is not connected."));
          return;
        }
        state = "sent";
        delivery = { digest: completionDigest(completionPayload), resolve, reject };
        messageQueue = messageQueue
          .then(async () => {
            await sendEncrypted(
              socket,
              publisher,
              "TrustchainShareCredential",
              requireCipher(cipher),
              request,
              { completion: completionPayload },
            );
            phaseTimer = deadlineTimer(timeouts.acknowledgementTimeoutMs, request.expiresAt, () =>
              fail(channelError("Enrollment completion acknowledgement timed out.")),
            );
          })
          .catch(fail);
      }),
    close: () => fail(channelError("This enrollment completion channel has been closed.")),
  };
}

type ChannelCipher = {
  key: CryptoKey;
  requestDigest: Uint8Array;
};

async function makeCipher(
  sharedSecret: Uint8Array,
  request: AgentEnrollmentChannelRequest,
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
  request: AgentEnrollmentChannelRequest,
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
  request: AgentEnrollmentChannelRequest,
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

/** Pings the relay until the returned stop function runs. */
function keepRelayAlive(socket: EnrollmentChannelWebSocket, onSilent?: () => void): () => void {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timer = setInterval(() => {
    try {
      socket.send(RELAY_KEEPALIVE_PING);
    } catch {
      // A socket that cannot send is closing; its close and error listeners report the failure.
    }
    if (onSilent) {
      clearTimeout(deadline);
      deadline = setTimeout(onSilent, RELAY_PONG_TIMEOUT_MS);
    }
  }, RELAY_KEEPALIVE_INTERVAL_MS);
  // Any frame proves the socket is alive, not only the pong. The socket type has no
  // removeEventListener; once stopped, this listener only clears a cleared timer.
  if (onSilent) socket.addEventListener("message", () => clearTimeout(deadline));
  return () => {
    clearInterval(timer);
    clearTimeout(deadline);
  };
}

function isRelayKeepAliveReply(data: unknown): boolean {
  return frameText(data) === RELAY_KEEPALIVE_PONG;
}

function frameText(data: unknown): string {
  return typeof data === "string" ? data : String(data);
}

function parseEnvelope(data: unknown): RelayEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(frameText(data));
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

function signedRequestDigest(request: AgentEnrollmentChannelRequest): Uint8Array {
  return sha256(
    concatBytes(
      isAgentRecoveryRequest(request)
        ? canonicalAgentRecoveryPayload(request)
        : canonicalAgentEnrollmentPayload(request),
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
  closeSocket: () => void,
  reject: (reason: unknown) => void,
  finished: () => boolean,
  beforeReject: () => void,
): (reason: unknown) => void {
  let failed = false;
  return (reason) => {
    if (failed || finished()) return;
    failed = true;
    beforeReject();
    closeSocket();
    reject(asChannelError(reason));
  };
}

function assertHostRequest(
  request: AgentEnrollmentChannelRequest,
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

function assertCandidateRequest(request: AgentEnrollmentChannelRequest, now: Date): void {
  const recovery = isAgentRecoveryRequest(request);
  if (
    (!recovery && request.version !== AGENT_ENROLLMENT_CHANNEL_VERSION) ||
    (request as { channel?: unknown }).channel === undefined
  ) {
    throw channelError("Automatic completion requires an enrollment channel request.");
  }
  const validation = recovery
    ? validateAgentRecovery(agentRecoverySearch(request), now)
    : validateAgentEnrollment(agentEnrollmentSearch(request), now);
  if (validation.status === "invalid") {
    throw channelError(
      validation.reason === "expired"
        ? "The enrollment channel has expired."
        : "The enrollment channel request is not authentic.",
    );
  }
}

function parseChannelCompletion(
  serialized: string,
  request: AgentEnrollmentChannelRequest,
): AgentEnrollmentChannelCompletion {
  if (isAgentRecoveryRequest(request)) {
    return parseAgentRecoveryCompletion(
      serialized,
      request.publicKey,
      request.previousTrustchainId,
      request.signature,
    );
  }
  const completion = parseAgentEnrollmentCompletion(serialized, request.publicKey);
  if (completion.version !== 2) {
    throw channelError("The enrollment channel requires completion version 2.");
  }
  return completion;
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
  signedRequestDigest: (request: AgentEnrollmentChannelRequest): string =>
    bytesToHex(signedRequestDigest(request)),
  deriveKey: (sharedSecret: Uint8Array, request: AgentEnrollmentChannelRequest): string =>
    bytesToHex(deriveChannelKeyBytes(sharedSecret, signedRequestDigest(request))),
  aad: (
    request: AgentEnrollmentChannelRequest,
    envelope: Pick<RelayEnvelope, "version" | "publisher" | "message">,
  ): string => new TextDecoder().decode(envelopeAad(envelope, signedRequestDigest(request))),
  encrypt: async (
    sharedSecret: Uint8Array,
    request: AgentEnrollmentChannelRequest,
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
