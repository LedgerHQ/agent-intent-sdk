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

// The relay has no rejection message and refuses frames outside its own protocol, so a rejection
// travels like a completion: the candidate sends it as TrustchainShareCredential and the host
// acknowledges it with TrustchainAddedMember. Only a rejection and its acknowledgement carry a
// `reason`; a completion carries `completion` and its acknowledgement `acknowledged`.
const USER_REJECTION = { reason: "user-rejected" } as const;
const REJECTION_ACKNOWLEDGEMENT = { reason: "rejection-acknowledged" } as const;
// The host refuses a rejection or a completion with a Failure. The relay reads a Failure as
// `{ type, message }`, takes `type` from its own list, and forwards the message of this type
// untouched, so the encrypted reason travels there. The relay then closes both sides.
const HOST_REFUSAL_TYPE = "UNEXPECTED_SHARE_CREDENTIAL";
type HostRefusalReason = "completion-received" | "reset";
const REJECTION_REFUSED_MESSAGE =
  "The enrollment host already received a completion for this request; it can no longer be rejected.";

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
   * reachable. Repeated calls share the open session, and a call made while
   * `deliver()` or `reject()` runs reports on that call's session.
   */
  connect(): Promise<void>;
  /**
   * Sends the serialized completion and resolves once the host acknowledges it.
   * Connects first when no session is open. After the host turns a delivery down
   * the candidate may retry on a fresh session while the signed request is unexpired.
   */
  deliver(completionPayload: string): Promise<void>;
  /**
   * Tells the host that the user rejected the signed request and resolves once
   * the host acknowledges it; the candidate is then unusable. Connects first
   * when no session is open. Never call it once the device has committed the
   * enrollment to the Trustchain: a rejection cannot undo that commit. It throws
   * once `deliver()` has been called, and fails for good once the host answers
   * that it already received a completion for this request. After any other
   * failure the host may still have honored the rejection, and `reject()` may be
   * retried on a fresh session.
   */
  reject(): Promise<void>;
  close(): void;
};

/** The user rejected the signed enrollment or recovery request in the frontend. */
export class AgentEnrollmentRejectedError extends AgentIntentSdkError {
  readonly kind: "enrollment" | "recovery";

  constructor(kind: "enrollment" | "recovery") {
    super(`The user rejected this agent ${kind} request.`);
    this.name = "AgentEnrollmentRejectedError";
    this.kind = kind;
  }
}

/**
 * Checked by shape rather than `instanceof`, so an error from another copy of the SDK or another
 * realm of the same process still matches. It must still be a real `Error`, which
 * `Object.prototype.toString` tells across realms. A structured clone, such as `postMessage` to a
 * worker, keeps neither the name nor `kind`, so a cloned error does not match.
 */
export function isAgentEnrollmentRejectedError(
  error: unknown,
): error is AgentEnrollmentRejectedError {
  if (Object.prototype.toString.call(error) !== "[object Error]") return false;
  const { name, kind, message } = error as { name?: unknown; kind?: unknown; message?: unknown };
  return (
    name === "AgentEnrollmentRejectedError" &&
    (kind === "enrollment" || kind === "recovery") &&
    typeof message === "string"
  );
}

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
  let pending: "delivery" | "rejection" | undefined;
  // Set once the device may have committed the enrollment, which a rejection cannot undo.
  let tooLateToReject: string | undefined;
  let delivered = false;
  let rejected = false;
  let closed = false;

  const assertUsable = () => {
    if (delivered) throw channelError("This enrollment completion has already been sent.");
    if (rejected) throw channelError("This enrollment request has already been rejected.");
    if (closed) throw channelError("This enrollment completion channel has been closed.");
    assertCandidateRequest(input.request, new Date());
  };
  const withSession = <T>(use: (active: CandidateSession) => Promise<T>): Promise<T> => {
    try {
      if (session === undefined || session.failed) {
        session = openCandidateSession(
          socketFactory(input.webSocketFactory)(
            relayUrl(input.relayBaseUrl, input.request.channel.hostPublicKey),
          ),
          input.request,
          timeouts,
        );
      }
      return use(session);
    } catch (error) {
      return Promise.reject(asChannelError(error));
    }
  };

  return {
    connect: () => {
      assertUsable();
      // A running delivery or rejection owns the session, even one whose loss is still being
      // reported, so connect() reports on it rather than opening another.
      if (pending !== undefined && session !== undefined) return session.ready;
      return withSession((active) => active.ready.then(() => undefined));
    },
    deliver: (completionPayload) => {
      if (pending === "delivery") {
        throw channelError("This enrollment completion is already being sent.");
      }
      if (pending === "rejection") throw channelError("This enrollment request is being rejected.");
      assertUsable();
      pending = "delivery";
      tooLateToReject ??=
        "This enrollment request can no longer be rejected once its completion delivery has started.";
      return withSession((active) => active.ready.then(() => active.deliver(completionPayload)))
        .then(() => {
          delivered = true;
        })
        .finally(() => {
          pending = undefined;
        });
    },
    reject: () => {
      // The host refuses it too once it received a completion; this check needs no round trip.
      if (tooLateToReject !== undefined) throw channelError(tooLateToReject);
      if (pending === "rejection") {
        throw channelError("This enrollment request is already being rejected.");
      }
      assertUsable();
      pending = "rejection";
      return withSession((active) =>
        active.reject().catch((error: unknown) => {
          // Final: each retry would only make the relay drop the host again and delay its reopening.
          if (active.rejectionRefused) tooLateToReject = REJECTION_REFUSED_MESSAGE;
          throw error;
        }),
      )
        .then(() => {
          rejected = true;
        })
        .finally(() => {
          pending = undefined;
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
    // Survives candidate resets: the frontend delivers only after the device committed the
    // enrollment to the Trustchain, so a later rejection could not undo it.
    let completionReceived = false;
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
    const answerCandidate = async (
      activeCipher: ChannelCipher,
      message: "TrustchainAddedMember" | "Failure",
      payload: object,
    ) => {
      try {
        await sendEncrypted(socket, identity.publicKey, message, activeCipher, request, payload);
      } catch {
        // The candidate may be gone already; the host session stays bounded either way.
      }
    };
    const dropCandidate = async (reason: HostRefusalReason) => {
      if (cipher) await answerCandidate(cipher, "Failure", { reason });
      resetCandidate();
    };
    const rejectCandidate = async (reason: unknown) => {
      await dropCandidate("reset");
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
    const failAsRejected = () =>
      fail(
        new AgentEnrollmentRejectedError(
          isAgentRecoveryRequest(request) ? "recovery" : "enrollment",
        ),
      );
    // A frame queued before the relay dropped its socket would answer a candidate that left, so
    // nothing is sent and nothing is authenticated. The confirmed peer's frames still count: a
    // completion means the device committed the enrollment, and a rejection needs no answer.
    const recordWithoutAnswer = async (data: unknown) => {
      if (state !== "authenticated") return;
      try {
        const envelope = parseEnvelope(data);
        assertPeer(envelope, peer);
        if (envelope.message !== "TrustchainShareCredential") return;
        const payload = await decryptPayload(requireCipher(cipher), envelope, request);
        const body = readShareCredential(payload, request);
        if (body.kind === "completion") completionReceived = true;
        else if (!completionReceived) failAsRejected();
      } catch {
        // Any other frame would only reset the candidate, which the reconnect does anyway.
      }
    };
    const handleMessage = (data: unknown, lost: () => boolean) => {
      messageQueue = messageQueue
        .then(async () => {
          if (settled) return;
          if (lost()) {
            await recordWithoutAnswer(data);
            return;
          }
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
            const activeCipher = requireCipher(cipher);
            const payload = await decryptPayload(activeCipher, envelope, request);
            const body = readShareCredential(payload, request);
            // Only a confirmed peer can reject, and only while no completion has been received.
            if (body.kind === "rejection") {
              if (completionReceived) {
                await dropCandidate("completion-received");
                return;
              }
              await answerCandidate(
                activeCipher,
                "TrustchainAddedMember",
                REJECTION_ACKNOWLEDGEMENT,
              );
              // Settles before closing, so the relay's later close neither reconnects nor overrides it.
              failAsRejected();
              return;
            }
            state = "authenticating";
            const { serialized, completion } = body;
            completionReceived = true;
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
  /** Whether the host refused a rejection because it already received a completion. */
  readonly rejectionRefused: boolean;
  deliver(completionPayload: string): Promise<void>;
  reject(): Promise<void>;
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
  let state:
    | "connecting"
    | "initiated"
    | "confirmed"
    | "ready"
    | "sent"
    | "rejecting"
    | "finished"
    | "failed" = "connecting";
  let cipher: ChannelCipher | undefined;
  let failure: AgentIntentSdkError | undefined;
  let phaseTimer: ReturnType<typeof setTimeout> | undefined;
  let stopKeepAlive: () => void = () => undefined;
  let messageQueue = Promise.resolve();
  let deliveryDigest = "";
  let awaitingAcknowledgement:
    | { resolve: () => void; reject: (reason: unknown) => void }
    | undefined;
  // What reject() reports instead of `failure` when the session fails the same way under a delivery.
  let rejectionFailure: AgentIntentSdkError | undefined;
  let rejectionRefused = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (reason: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Callers observe failures through connect(), deliver() and reject(); an idle session must not
  // leak a rejection.
  ready.catch(() => undefined);

  const fail = failChannel(
    () => socket.close(),
    (error) => {
      failure = asChannelError(error);
      rejectReady(failure);
      awaitingAcknowledgement?.reject(failure);
    },
    () => state === "finished",
    () => {
      state = "failed";
      clearTimeout(phaseTimer);
      clearTimeout(sessionTimer);
      stopKeepAlive();
    },
  );
  const failNamingRejection = (message: string, rejectionMessage: string) => {
    if (state === "failed" || state === "finished") return;
    rejectionFailure = channelError(rejectionMessage);
    fail(channelError(message));
  };
  // Bounds the whole session, including the device-approval gap between connect() and deliver().
  const sessionTimer = deadlineTimer(timeouts.completionTimeoutMs, request.expiresAt, () =>
    failNamingRejection(
      "Enrollment completion delivery timed out.",
      "Enrollment rejection timed out.",
    ),
  );
  phaseTimer = deadlineTimer(timeouts.handshakeTimeoutMs, request.expiresAt, () =>
    fail(channelError("Enrollment channel handshake timed out.")),
  );
  // The relay closes right after it forwards the host's refusal, so a lost socket is reported
  // behind the frames already received. The session counts as failed at once, so that the next
  // call opens a fresh one.
  let socketLost = false;
  const loseSocket = (report: () => void) => {
    socketLost = true;
    messageQueue = messageQueue.then(report);
  };
  socket.addEventListener("error", () =>
    loseSocket(() => fail(channelError("Enrollment relay connection failed."))),
  );
  socket.addEventListener("close", () =>
    loseSocket(() =>
      failNamingRejection(
        "Enrollment relay closed before completion was acknowledged.",
        state === "rejecting"
          ? "Enrollment relay closed before the rejection was acknowledged."
          : "Enrollment relay closed before the rejection was sent.",
      ),
    ),
  );
  const finish = () => {
    state = "finished";
    clearTimeout(phaseTimer);
    clearTimeout(sessionTimer);
    stopKeepAlive();
    socket.close();
  };
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
        const fromHost =
          envelope.publisher.toLowerCase() === request.channel.hostPublicKey.toLowerCase();
        if (envelope.message === "Failure") {
          // The relay's own Failure does not carry the host key as publisher, and only the
          // host's refusal decrypts.
          const refusal = fromHost
            ? await decryptPayload(cipher, envelope, request).catch(() => undefined)
            : undefined;
          if (refusal === undefined)
            throw channelError("The enrollment relay rejected the session.");
          if (state === "rejecting" && isReasonBody(refusal, "completion-received")) {
            rejectionRefused = true;
            throw channelError(REJECTION_REFUSED_MESSAGE);
          }
          throw channelError(
            state === "sent"
              ? "The enrollment host rejected this completion."
              : "The enrollment host reset this session.",
          );
        }
        if (!fromHost) {
          throw channelError("Enrollment channel host does not match the signed request.");
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
            hasReason(acknowledgement) ||
            acknowledgement.acknowledged !== true ||
            stringField(acknowledgement, "digest") !== deliveryDigest
          ) {
            throw channelError("Enrollment completion acknowledgement is invalid.");
          }
          finish();
          awaitingAcknowledgement?.resolve();
          return;
        }

        if (state === "rejecting" && envelope.message === "TrustchainAddedMember") {
          const acknowledgement = await decryptPayload(cipher, envelope, request);
          if (!isReasonBody(acknowledgement, REJECTION_ACKNOWLEDGEMENT.reason)) {
            throw channelError("Enrollment rejection acknowledgement is invalid.");
          }
          finish();
          awaitingAcknowledgement?.resolve();
          return;
        }

        throw channelError(`Unexpected ${envelope.message} enrollment channel message.`);
      })
      .catch(fail);
  });

  // A session carries one delivery or one rejection; either waits for the host to acknowledge it.
  const sendAndAwaitAcknowledgement = (
    next: "sent" | "rejecting",
    payload: object,
    timeoutMessage: string,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (state !== "ready") {
        reject(failure ?? channelError("Enrollment channel is not connected."));
        return;
      }
      state = next;
      awaitingAcknowledgement = { resolve, reject };
      messageQueue = messageQueue
        .then(async () => {
          await sendEncrypted(
            socket,
            publisher,
            "TrustchainShareCredential",
            requireCipher(cipher),
            request,
            payload,
          );
          if (state !== next) return;
          phaseTimer = deadlineTimer(timeouts.acknowledgementTimeoutMs, request.expiresAt, () =>
            fail(channelError(timeoutMessage)),
          );
        })
        .catch(fail);
    });

  return {
    ready,
    get failed() {
      return state === "failed" || socketLost;
    },
    get rejectionRefused() {
      return rejectionRefused;
    },
    deliver: (completionPayload) => {
      deliveryDigest = completionDigest(completionPayload);
      return sendAndAwaitAcknowledgement(
        "sent",
        { completion: completionPayload },
        "Enrollment completion acknowledgement timed out.",
      );
    },
    reject: () =>
      ready
        .then(() =>
          sendAndAwaitAcknowledgement(
            "rejecting",
            USER_REJECTION,
            "Enrollment rejection acknowledgement timed out.",
          ),
        )
        .catch((error: unknown) => {
          throw rejectionFailure ?? error;
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
  const blob = base64ToBytes(ciphertextOf(envelope));
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
  send(socket, await sealEnvelope(cipher, metadata, payload));
}

/** Encrypts the payload into the field the relay forwards for this message. */
async function sealEnvelope(
  cipher: ChannelCipher,
  metadata: Pick<RelayEnvelope, "version" | "publisher" | "message">,
  payload: object,
  nonce?: Uint8Array,
): Promise<RelayEnvelope> {
  const encrypted = await encryptPayload(cipher, metadata, payload, nonce);
  return {
    ...metadata,
    payload:
      metadata.message === "Failure"
        ? { type: HOST_REFUSAL_TYPE, message: encrypted }
        : { encrypted },
  };
}

/** Reads the ciphertext from where `sealEnvelope` puts it; any other payload shape is refused. */
function ciphertextOf({ message, payload }: RelayEnvelope): string {
  const fields = Object.keys(payload);
  const field = message === "Failure" ? "message" : "encrypted";
  if (
    fields.length !== (message === "Failure" ? 2 : 1) ||
    !Object.prototype.hasOwnProperty.call(payload, field) ||
    (message === "Failure" && payload.type !== HOST_REFUSAL_TYPE)
  ) {
    throw channelError("Enrollment channel encrypted envelope is malformed.");
  }
  return stringField(payload, field);
}

type ShareCredential =
  | { kind: "rejection" }
  | { kind: "completion"; serialized: string; completion: AgentEnrollmentChannelCompletion };

/**
 * Reads a TrustchainShareCredential body, which is a completion or the user's rejection. Only
 * the rejection carries a `reason`, so a body with one is exactly the rejection or invalid, and
 * never a completion. An invalid body throws.
 */
function readShareCredential(
  payload: Record<string, unknown>,
  request: AgentEnrollmentChannelRequest,
): ShareCredential {
  if (hasReason(payload)) {
    if (!isReasonBody(payload, USER_REJECTION.reason)) {
      throw channelError("Enrollment channel rejection is invalid.");
    }
    return { kind: "rejection" };
  }
  const serialized = stringField(payload, "completion");
  return {
    kind: "completion",
    serialized,
    completion: parseChannelCompletion(serialized, request),
  };
}

/** Only the bodies of a rejection and its answers carry a `reason`. */
function hasReason(payload: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(payload, "reason");
}

function isReasonBody(payload: Record<string, unknown>, reason: string): boolean {
  return Object.keys(payload).length === 1 && payload.reason === reason;
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
  /** The whole relay frame, as the channel sends it. */
  envelope: async (
    sharedSecret: Uint8Array,
    request: AgentEnrollmentChannelRequest,
    envelope: Pick<RelayEnvelope, "version" | "publisher" | "message">,
    payload: object,
    nonce: Uint8Array,
  ): Promise<string> =>
    JSON.stringify(
      await sealEnvelope(await makeCipher(sharedSecret, request), envelope, payload, nonce),
    ),
};

function asChannelError(reason: unknown): AgentIntentSdkError {
  return reason instanceof AgentIntentSdkError
    ? reason
    : channelError(reason instanceof Error ? reason.message : "Enrollment channel failed.");
}

function channelError(message: string): AgentIntentSdkError {
  return new AgentIntentSdkError(message);
}
