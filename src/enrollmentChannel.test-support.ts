// Shared fixtures for the enrollment channel test files.
import { expect, vi } from "vitest";
import { hexToBytes } from "./bytes.ts";
import { serializeAgentEnrollmentCompletion } from "./completion.ts";
import { createAgentEnrollmentRequest } from "./enrollment.ts";
import {
  createAgentEnrollmentChannelCandidate,
  createAgentEnrollmentChannelHost,
  enrollmentChannelCryptoVectors,
  type AgentEnrollmentChannelRequest,
  type AgentEnrollmentChannelTimeouts,
  type EnrollmentChannelWebSocket,
  type EnrollmentChannelWebSocketFactory,
} from "./enrollmentChannel.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";
import { createAgentRecoveryRequest } from "./recovery.ts";

export const RELAY_URL = "https://trustchain.example";

/** A host waiting on a plain test relay with real timers; `hostFailure` records its rejection. */
export function waitingHost(
  makeRequest: (
    agent: ReturnType<typeof createSoftwareAgentIdentity>,
    channel: { environment: "staging" | "production"; hostPublicKey: string },
  ) => AgentEnrollmentChannelRequest = channelRequest,
  wrapHostFactory = (factory: EnrollmentChannelWebSocketFactory) => factory,
) {
  const relay = new TestRelay();
  const agent = createSoftwareAgentIdentity();
  const host = createAgentEnrollmentChannelHost({
    environment: "production",
    relayBaseUrl: RELAY_URL,
    webSocketFactory: wrapHostFactory(relay.factory),
  });
  const request = makeRequest(agent, host.binding);
  const authenticate = vi.fn(async () => undefined);
  const persist = vi.fn(async () => undefined);
  const waiting = host.waitForCompletion({ request, authenticate, persist });
  const hostFailure = vi.fn();
  void waiting.catch(hostFailure);
  return {
    relay,
    agent,
    host,
    request,
    authenticate,
    persist,
    waiting,
    hostFailure,
    candidate: (
      options: {
        timeouts?: AgentEnrollmentChannelTimeouts;
        webSocketFactory?: EnrollmentChannelWebSocketFactory;
      } = {},
    ) =>
      createAgentEnrollmentChannelCandidate({
        request,
        relayBaseUrl: RELAY_URL,
        webSocketFactory: options.webSocketFactory ?? relay.factory,
        timeouts: options.timeouts,
      }),
  };
}

/** The host did not settle, and a fresh candidate can still complete it. */
export async function expectHostStillWaiting(setup: ReturnType<typeof waitingHost>): Promise<void> {
  expect(setup.hostFailure).not.toHaveBeenCalled();
  await expect(
    setup.candidate().deliver(completionFor(setup.agent.publicKey, "still-waiting")),
  ).resolves.toBeUndefined();
  await expect(setup.waiting).resolves.toMatchObject({ trustchainId: "still-waiting" });
}

/** Drops every acknowledgement the wrapped sockets send. */
export function withoutAcknowledgements(
  factory: EnrollmentChannelWebSocketFactory,
): EnrollmentChannelWebSocketFactory {
  return (url) => {
    const socket = factory(url);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      if (!data.includes('"TrustchainAddedMember"')) send(data);
    };
    return socket;
  };
}

/** Records every relay frame the wrapped sockets send, keepalive pings aside. */
export function recordingFrames(frames: RelayFrame[]) {
  return (factory: EnrollmentChannelWebSocketFactory): EnrollmentChannelWebSocketFactory =>
    (url) => {
      const socket = factory(url);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (data !== "ping") frames.push(JSON.parse(data) as RelayFrame);
        send(data);
      };
      return socket;
    };
}

/**
 * The relay's schema: a Failure is `{ type, message }` with `type` from its own list, and it
 * forwards the message of this type untouched; any other message is `{ encrypted }`.
 */
export function expectRelayPayload(frame: RelayFrame): void {
  expect(frame.payload).toStrictEqual(
    frame.message === "Failure"
      ? { type: "UNEXPECTED_SHARE_CREDENTIAL", message: expect.any(String) }
      : { encrypted: expect.any(String) },
  );
}

export function ciphertextField(frame: RelayFrame): "message" | "encrypted" {
  return frame.message === "Failure" ? "message" : "encrypted";
}

/** Flips one bit of an encrypted envelope's ciphertext. */
export function tamperedFrame(frame: string): string {
  return editFrame(frame, (envelope) => {
    const field = ciphertextField(envelope);
    const blob = Buffer.from(String(envelope.payload[field]), "base64");
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 1, blob.length - 1);
    envelope.payload[field] = blob.toString("base64");
  });
}

export function editFrame(frame: string, edit: (envelope: RelayFrame) => void): string {
  const envelope = JSON.parse(frame) as RelayFrame;
  edit(envelope);
  return JSON.stringify(envelope);
}

export type ChannelMessage = Parameters<
  typeof enrollmentChannelCryptoVectors.encrypt
>[2]["message"];

export type RelayFrame = {
  version: number;
  publisher: string;
  message: ChannelMessage;
  payload: Record<string, unknown>;
};

export type ChannelPeer = ReturnType<typeof channelPeer>;

/** Seals and opens channel envelopes with a key the test holds, to speak the protocol by hand. */
export function channelPeer(
  request: AgentEnrollmentChannelRequest,
  identity: ReturnType<typeof createSoftwareAgentIdentity>,
  counterpartPublicKey: string,
) {
  const sharedSecret = identity.deriveSharedSecret(hexToBytes(counterpartPublicKey));
  const publisher = identity.publicKey;
  return {
    seal: (message: ChannelMessage, payload: object): Promise<string> =>
      enrollmentChannelCryptoVectors.envelope(
        sharedSecret,
        request,
        { version: 1, publisher, message },
        payload,
        crypto.getRandomValues(new Uint8Array(12)),
      ),
    /** Decrypts a frame the SDK sent, after checking it against the relay's schema. */
    open: async (frame: string) => {
      const envelope = JSON.parse(frame) as RelayFrame;
      expectRelayPayload(envelope);
      const key = await crypto.subtle.importKey(
        "raw",
        Buffer.from(enrollmentChannelCryptoVectors.deriveKey(sharedSecret, request), "hex"),
        "AES-GCM",
        false,
        ["decrypt"],
      );
      const blob = Buffer.from(String(envelope.payload[ciphertextField(envelope)]), "base64");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: blob.subarray(0, 12),
          additionalData: Buffer.from(enrollmentChannelCryptoVectors.aad(request, envelope)),
        },
        key,
        blob.subarray(12),
      );
      return {
        message: envelope.message,
        payload: JSON.parse(Buffer.from(plaintext).toString()) as Record<string, unknown>,
      };
    },
  };
}

/** A relay socket the test drives by hand; the frames it receives are read in order. */
export function rawSocket(relay: TestRelay) {
  const socket = relay.factory(`${RELAY_URL}/v1/qr`);
  const frames: string[] = [];
  // Resolved on arrival rather than polled: vi.waitFor sleeps 50 ms between checks.
  const readers: Array<(frame: string) => void> = [];
  const opened = new Promise<void>((resolve) => socket.addEventListener("open", resolve));
  socket.addEventListener("message", (event) => {
    const reader = readers.shift();
    if (reader) reader(String(event.data));
    else frames.push(String(event.data));
  });
  return {
    socket,
    opened,
    next: (): Promise<string> => {
      const frame = frames.shift();
      return frame === undefined
        ? new Promise((resolve) => readers.push(resolve))
        : Promise.resolve(frame);
    },
  };
}

/** A host whose key the test holds on a plain relay, facing a candidate the SDK runs. */
export async function rawHost() {
  const relay = new TestRelay();
  const identity = createSoftwareAgentIdentity();
  const request = channelRequest(createSoftwareAgentIdentity(), {
    environment: "production",
    hostPublicKey: identity.publicKey,
  });
  const host = rawSocket(relay);
  await host.opened;
  return {
    ...host,
    request,
    candidate: () =>
      createAgentEnrollmentChannelCandidate({
        request,
        relayBaseUrl: RELAY_URL,
        webSocketFactory: relay.factory,
      }),
    /** Confirms the next candidate's handshake and returns the channel to it. */
    confirm: async () => {
      const initiate = JSON.parse(await host.next()) as { publisher: string };
      const peer = channelPeer(request, identity, initiate.publisher);
      host.socket.send(
        await peer.seal("HandshakeChallenge", { digits: "123456", connected: false }),
      );
      expect(await peer.open(await host.next())).toEqual({
        message: "CompleteHandshakeChallenge",
        payload: { digits: "123456" },
      });
      host.socket.send(await peer.seal("HandshakeCompletionSucceeded", {}));
      return peer;
    },
  };
}

/** A candidate whose key the test holds, left challenged until `confirm()` answers. */
export async function rawCandidate(relay: TestRelay, request: AgentEnrollmentChannelRequest) {
  const identity = createSoftwareAgentIdentity();
  const peer = channelPeer(request, identity, request.channel.hostPublicKey);
  const raw = rawSocket(relay);
  await raw.opened;
  raw.socket.send(
    JSON.stringify({
      version: 1,
      publisher: identity.publicKey,
      message: "InitiateHandshake",
      payload: { ephemeral_public_key: identity.publicKey },
    }),
  );
  const challenge = await peer.open(await raw.next());
  expect(challenge.message).toBe("HandshakeChallenge");
  return {
    ...peer,
    ...raw,
    confirm: async () => {
      raw.socket.send(
        await peer.seal("CompleteHandshakeChallenge", { digits: challenge.payload.digits }),
      );
      expect((await peer.open(await raw.next())).message).toBe("HandshakeCompletionSucceeded");
    },
  };
}

export function reconnectTimeouts() {
  return {
    candidateTimeoutMs: 30 * 60_000,
    handshakeTimeoutMs: 30 * 60_000,
    completionTimeoutMs: 30 * 60_000,
    acknowledgementTimeoutMs: 30 * 60_000,
    persistTimeoutMs: 30 * 60_000,
  };
}

/** A host on a relay that behaves like the Trustchain one, with fake timers. */
export function pairedHost(
  timeouts = reconnectTimeouts(),
  wrapHostFactory = (factory: EnrollmentChannelWebSocketFactory) => factory,
) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
  const relay = new TestRelay();
  relay.pairedChannel = true;
  const agent = createSoftwareAgentIdentity();
  const host = createAgentEnrollmentChannelHost({
    environment: "production",
    relayBaseUrl: RELAY_URL,
    webSocketFactory: wrapHostFactory(relay.hostFactory),
    timeouts,
  });
  const request = channelRequest(agent, host.binding);
  const authenticate = vi.fn(async () => undefined);
  const persist = vi.fn(async () => undefined);
  const candidate = () =>
    createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
  return {
    relay,
    agent,
    host,
    request,
    authenticate,
    persist,
    candidate,
    start: () => {
      let settled = false;
      const waiting = host.waitForCompletion({ request, authenticate, persist });
      waiting.then(
        () => (settled = true),
        () => (settled = true),
      );
      return { waiting, isSettled: () => settled };
    },
    // A reviewer opens the page, completes the handshake, leaves, and the relay closes the host.
    leave: async () => {
      const visit = candidate();
      await visit.connect();
      visit.close();
      await vi.advanceTimersByTimeAsync(relay.peerCloseDelayMs);
    },
  };
}

/** Expects no new host socket for `delayMs - 1` milliseconds, then one at `delayMs`. */
export async function expectNextSocketAfter(
  setup: ReturnType<typeof pairedHost>,
  delayMs: number,
): Promise<void> {
  const sockets = setup.relay.hostSockets.length;
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  expect(setup.relay.hostSockets).toHaveLength(sockets);
  await vi.advanceTimersByTimeAsync(1);
  expect(setup.relay.hostSockets).toHaveLength(sockets + 1);
}

/** Connects a candidate that sends InitiateHandshake, then nothing; resolves once challenged. */
export async function silentCandidate(setup: ReturnType<typeof pairedHost>): Promise<TestSocket> {
  const challenged = new Promise<void>((resolve) => {
    setup.relay.onSend = (_sender, message) => {
      if (message === "HandshakeChallenge") resolve();
    };
  });
  let silent: TestSocket | undefined;
  const candidate = createAgentEnrollmentChannelCandidate({
    request: setup.request,
    relayBaseUrl: RELAY_URL,
    timeouts: reconnectTimeouts(),
    webSocketFactory: (url) => {
      const socket = setup.relay.factory(url) as TestSocket;
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (data.includes("InitiateHandshake")) send(data);
      };
      silent = socket;
      return socket;
    },
  });
  void candidate.connect().catch(() => undefined);
  await challenged;
  setup.relay.onSend = undefined;
  if (!silent) throw new Error("expected a candidate socket");
  return silent;
}

export function relayFailure(type = "PROTOCOL_VIOLATION") {
  return {
    version: 1,
    publisher: "00".repeat(33),
    message: "Failure",
    payload: {
      type,
      message:
        type === "PEER_INVALID_MESSAGE"
          ? "Peer sent an invalid message"
          : "Expected another message at this point in the protocol",
    },
  };
}

export function channelRequest(
  agent: ReturnType<typeof createSoftwareAgentIdentity>,
  channel: { environment: "staging" | "production"; hostPublicKey: string },
) {
  const request = createAgentEnrollmentRequest(agent, {
    name: "Portfolio Bot",
    description: "Proposes portfolio operations.",
    source: "openclaw",
    expiresAt: "2099-01-01T00:00:00.000Z",
    channel,
  });
  if (request.version !== "2") throw new Error("expected channel request");
  return request;
}

export function recoveryChannelRequest(
  agent: ReturnType<typeof createSoftwareAgentIdentity>,
  channel: { environment: "staging" | "production"; hostPublicKey: string },
) {
  return createAgentRecoveryRequest(agent, {
    name: "Portfolio Bot",
    description: "Proposes portfolio operations.",
    source: "hermes",
    previousTrustchainId: "app-18-root",
    expiresAt: "2099-01-01T00:00:00.000Z",
    channel,
  });
}

export function completionFor(agentPubkey: string, trustchainId: string): string {
  return serializeAgentEnrollmentCompletion({
    agentPubkey,
    trustchainId,
    accountAccess: {
      mode: "direct-app16-key-reader",
      environment: "production",
      trustchainId: "app-16-id",
      applicationPath: "m/0'/16'/0'",
    },
  });
}

export function shortTimeouts() {
  return {
    candidateTimeoutMs: 100,
    handshakeTimeoutMs: 100,
    completionTimeoutMs: 100,
    acknowledgementTimeoutMs: 100,
    persistTimeoutMs: 100,
  };
}

export class TestSocket implements EnrollmentChannelWebSocket {
  readonly listenerCount = {
    open: 0,
    message: 0,
    error: 0,
    close: 0,
  };
  closed = false;
  private readonly listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(event: { data: unknown }) => void>,
    error: [] as Array<() => void>,
    close: [] as Array<() => void>,
  };

  constructor(private readonly relay: TestRelay) {}

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    this.relay.forward(this, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.left(this);
    if (!this.relay.socketsEmitClose) return;
    if (this.relay.closeEventDelayMs === undefined) queueMicrotask(() => this.emit("close"));
    else setTimeout(() => this.emit("close"), this.relay.closeEventDelayMs);
  }

  /** Closes and reports it in the same task, before handlers queued for earlier frames run. */
  drop(): void {
    this.closed = true;
    this.relay.left(this);
    this.emit("close");
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: never): void {
    (this.listeners[type] as unknown[]).push(listener);
    this.listenerCount[type] += 1;
  }

  emit(type: "open" | "error" | "close"): void;
  emit(type: "message", event: { data: unknown }): void;
  emit(type: "open" | "message" | "error" | "close", event?: { data: unknown }): void {
    for (const listener of this.listeners[type] as Array<(value?: { data: unknown }) => void>) {
      listener(event);
    }
  }
}

export class TestRelay {
  readonly sockets: TestSocket[] = [];
  /** Like the Trustchain relay: drop a socket after this long without a frame sent to it. */
  idleTimeoutMs: number | undefined;
  pings = 0;
  /** Answer each text ping with a pong; turn off to model a half-open socket. */
  answerPings = true;
  /** Deliver frames as Buffers, like some Node WebSocket clients. */
  binaryFrames = false;
  /** Whether a closed socket emits a close event; custom factories might not. */
  socketsEmitClose = true;
  /**
   * Like the Trustchain relay: a channel holds one host and one candidate, refuses a third
   * socket, rejects a handshake that arrives before the host, and closes the remaining side
   * once the other leaves.
   */
  pairedChannel = false;
  /** How long the paired relay takes to close the remaining side; measured at 1.1–1.5 s. */
  peerCloseDelayMs = 1_100;
  /** Fail the next host sockets before they open, like a refused upgrade or a network error. */
  refuseNextSockets = 0;
  /** Report a refused socket's failure this long after it was created. */
  refuseDelayMs = 0;
  /** Drop the recipient right after delivering this message, before its handler runs. */
  dropRecipientAfter: string | undefined;
  /** Report close this long after `close()`, like a real closing handshake. */
  closeEventDelayMs: number | undefined;
  /** Runs when a socket sends a frame, before the relay forwards it. */
  onSend: ((sender: TestSocket, message: string | undefined) => void) | undefined;
  /** Sockets opened through `hostFactory`, in order. */
  readonly hostSockets: TestSocket[] = [];
  private readonly idleTimers = new Map<TestSocket, ReturnType<typeof setTimeout>>();
  private readonly rooms = new Map<string, TestSocket[]>();

  constructor(
    private readonly droppedMessage?: string,
    private readonly duplicatedMessage?: string,
  ) {}

  readonly factory: EnrollmentChannelWebSocketFactory = (url) => this.open(url, false);

  readonly hostFactory: EnrollmentChannelWebSocketFactory = (url) => {
    const socket = this.open(url, this.refuseNextSockets > 0);
    this.refuseNextSockets = Math.max(0, this.refuseNextSockets - 1);
    this.hostSockets.push(socket);
    return socket;
  };

  private open(url: string, refused: boolean): TestSocket {
    const socket = new TestSocket(this);
    this.sockets.push(socket);
    if (refused || (this.pairedChannel && this.room(url).length >= 2)) {
      socket.closed = true;
      const report = () => {
        socket.emit("error");
        socket.emit("close");
      };
      if (refused && this.refuseDelayMs > 0) setTimeout(report, this.refuseDelayMs);
      else queueMicrotask(report);
      return socket;
    }
    if (this.pairedChannel) this.room(url).push(socket);
    this.touch(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  }

  forward(sender: TestSocket, data: string): void {
    if (data === "ping") {
      this.pings += 1;
      if (this.answerPings) this.deliver(sender, "pong");
      return;
    }
    const envelope = JSON.parse(data) as { message?: string };
    this.onSend?.(sender, envelope.message);
    if (envelope.message === this.droppedMessage) return;
    if (this.pairedChannel) {
      this.forwardInRoom(sender, data, envelope.message);
      return;
    }
    const host = this.sockets[0];
    const recipients =
      sender === host ? this.sockets.slice(1).filter((socket) => !socket.closed) : [host];
    for (const recipient of recipients) {
      if (recipient && !recipient.closed) {
        this.deliver(recipient, data);
        if (envelope.message === this.duplicatedMessage) this.deliver(recipient, data);
      }
    }
  }

  left(socket: TestSocket): void {
    const room = [...this.rooms.values()].find((members) => members.includes(socket));
    if (!room) return;
    room.splice(room.indexOf(socket), 1);
    for (const peer of room.splice(0)) setTimeout(() => peer.close(), this.peerCloseDelayMs);
  }

  private forwardInRoom(sender: TestSocket, data: string, message: string | undefined): void {
    const room = [...this.rooms.values()].find((members) => members.includes(sender));
    if (!room) return;
    if (message === "InitiateHandshake" && sender === room[0]) {
      this.deliver(sender, JSON.stringify(relayFailure()));
      for (const member of room.splice(0)) {
        setTimeout(() => member.close(), this.peerCloseDelayMs);
      }
      return;
    }
    for (const recipient of room) {
      if (recipient !== sender) {
        this.deliver(recipient, data, message === this.dropRecipientAfter);
      }
    }
  }

  private room(url: string): TestSocket[] {
    const room = this.rooms.get(url) ?? [];
    this.rooms.set(url, room);
    return room;
  }

  private deliver(recipient: TestSocket, data: string, dropAfter = false): void {
    this.touch(recipient);
    const frame = this.binaryFrames ? Buffer.from(data) : data;
    queueMicrotask(() => {
      recipient.emit("message", { data: frame });
      if (dropAfter) recipient.drop();
    });
  }

  private touch(socket: TestSocket): void {
    if (this.idleTimeoutMs === undefined) return;
    clearTimeout(this.idleTimers.get(socket));
    this.idleTimers.set(
      socket,
      setTimeout(() => socket.close(), this.idleTimeoutMs),
    );
  }
}
