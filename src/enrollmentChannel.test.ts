import { afterEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "./bytes.ts";
import { serializeAgentEnrollmentCompletion } from "./completion.ts";
import {
  agentEnrollmentSearch,
  canonicalAgentEnrollmentPayload,
  createAgentEnrollmentRequest,
  validateAgentEnrollment,
} from "./enrollment.ts";
import {
  AGENT_ENROLLMENT_CHANNEL_DEFAULT_TIMEOUTS,
  createAgentEnrollmentChannelCandidate,
  createAgentEnrollmentChannelHost,
  enrollmentChannelCryptoVectors,
  type EnrollmentChannelWebSocket,
  type EnrollmentChannelWebSocketFactory,
} from "./enrollmentChannel.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";
import * as packageExports from "./index.ts";

const RELAY_URL = "https://trustchain.example";

describe("encrypted enrollment channel", () => {
  afterEach(() => vi.useRealTimers());

  it("allows 15 minutes for human approval while keeping the handshake at 30 seconds", () => {
    expect(AGENT_ENROLLMENT_CHANNEL_DEFAULT_TIMEOUTS).toMatchObject({
      candidateTimeoutMs: 15 * 60_000,
      handshakeTimeoutMs: 30_000,
    });
  });

  it("binds the host key into a signed version-2 request", () => {
    const identity = createSoftwareAgentIdentity("00".repeat(31) + "01");
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: new TestRelay().factory,
    });
    const request = createAgentEnrollmentRequest(identity, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "hermes",
      expiresAt: "2099-01-01T00:00:00.000Z",
      channel: host.binding,
    });

    expect(request.version).toBe("2");
    expect(validateAgentEnrollment(agentEnrollmentSearch(request))).toEqual({
      status: "valid",
      request,
    });
    expect(
      validateAgentEnrollment({
        ...agentEnrollmentSearch(request),
        channelHost: createSoftwareAgentIdentity().publicKey,
      }),
    ).toMatchObject({ status: "invalid", reason: "invalid-signature" });
    expect(
      validateAgentEnrollment({
        ...agentEnrollmentSearch(request),
        channelHost: `02${"ff".repeat(32)}`,
      }),
    ).toMatchObject({ status: "invalid", reason: "malformed" });
    host.close();
  });

  it("delivers version-2 completion only after durable persistence and acknowledgement", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "staging",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = createAgentEnrollmentRequest(agent, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "openclaw",
      expiresAt: "2099-01-01T00:00:00.000Z",
      channel: host.binding,
    });
    if (request.version !== "2") throw new Error("expected channel request");

    const completionPayload = serializeAgentEnrollmentCompletion({
      agentPubkey: agent.publicKey,
      trustchainId: "app-18-id",
      accountAccess: {
        mode: "direct-app16-key-reader",
        environment: "production",
        trustchainId: "app-16-id",
        applicationPath: "m/0'/16'/0'",
      },
    });
    expect(completionPayload).not.toMatch(
      /walletSyncEncryptionKey|privateKey|accessToken|serializedTrustchain/i,
    );

    const persist = vi.fn(async () => undefined);
    const authenticate = vi.fn(async () => undefined);
    const received = host.waitForCompletion({
      request,
      authenticate,
      persist,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    await expect(candidate.deliver(completionPayload)).resolves.toBeUndefined();
    await expect(received).resolves.toMatchObject({
      version: 2,
      agentPubkey: agent.publicKey,
      trustchainId: "app-18-id",
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledOnce();
    expect(authenticate.mock.invocationCallOrder[0]).toBeLessThan(
      persist.mock.invocationCallOrder[0]!,
    );
    expect(relay.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("rejects an unauthenticated candidate, then accepts a valid candidate", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = createAgentEnrollmentRequest(agent, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "openclaw",
      expiresAt: "2099-01-01T00:00:00.000Z",
      channel: host.binding,
    });
    if (request.version !== "2") throw new Error("expected channel request");

    expect(() =>
      createAgentEnrollmentChannelCandidate({
        request,
        relayBaseUrl: RELAY_URL,
        webSocketFactory: relay.factory,
        now: new Date("2100-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/expired/);

    const authenticate = vi.fn(async (completion: { trustchainId: string }) => {
      if (completion.trustchainId === "untrusted") throw new Error("membership proof failed");
    });
    const persist = vi.fn(async () => undefined);
    const received = host.waitForCompletion({
      request,
      authenticate,
      persist,
    });
    const hostFailure = vi.fn();
    void received.catch(hostFailure);
    const invalidCandidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    await expect(
      invalidCandidate.deliver(completionFor(agent.publicKey, "untrusted")),
    ).rejects.toThrow(/host rejected/);
    expect(persist).not.toHaveBeenCalled();
    expect(hostFailure).not.toHaveBeenCalled();

    const validCandidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    await expect(
      validCandidate.deliver(completionFor(agent.publicKey, "trusted")),
    ).resolves.toBeUndefined();
    await expect(received).resolves.toMatchObject({ trustchainId: "trusted" });
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledOnce();
    expect(() => invalidCandidate.deliver(completionFor(agent.publicKey, "untrusted"))).toThrow(
      /already been sent/,
    );
    expect(() =>
      host.waitForCompletion({
        request,
        authenticate: async () => undefined,
        persist: async () => undefined,
      }),
    ).toThrow(/already been used/);
  });

  it("creates sockets lazily and installs every listener before open is emitted", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: shortTimeouts(),
    });
    const request = channelRequest(agent, host.binding);
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: shortTimeouts(),
    });

    expect(relay.sockets).toHaveLength(0);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    expect(relay.sockets).toHaveLength(1);
    expect(relay.sockets[0]?.listenerCount).toEqual({
      open: 0,
      message: 1,
      error: 1,
      close: 1,
    });
    const delivering = candidate.deliver(completionFor(agent.publicKey, "trusted"));
    expect(relay.sockets).toHaveLength(2);
    expect(relay.sockets[1]?.listenerCount).toEqual({
      open: 1,
      message: 1,
      error: 1,
      close: 1,
    });

    await expect(delivering).resolves.toBeUndefined();
    await expect(waiting).resolves.toBeDefined();
  });

  it("keeps the host available while Ledger approval exceeds 30 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = createAgentEnrollmentRequest(agent, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "openclaw",
      expiresAt: "2098-01-01T00:30:00.000Z",
      channel: host.binding,
    });
    if (request.version !== "2") throw new Error("expected channel request");
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(31_700);
    expect(relay.sockets[0]?.closed).toBe(false);

    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    await expect(
      candidate.deliver(completionFor(agent.publicKey, "trusted")),
    ).resolves.toBeUndefined();
    await expect(waiting).resolves.toBeDefined();
  });

  it.each([
    {
      name: "host completion",
      configure: () => ({ completionTimeoutMs: 10 }),
      startCandidate: false,
      expected: /completion timed out/,
    },
    {
      name: "host wait before the first candidate",
      configure: () => ({ candidateTimeoutMs: 10, completionTimeoutMs: 100 }),
      startCandidate: false,
      expected: /waiting for the frontend candidate/,
    },
    {
      name: "candidate handshake",
      configure: () => ({ handshakeTimeoutMs: 10 }),
      startCandidate: true,
      expected: /handshake timed out/,
    },
    {
      name: "candidate delivery",
      configure: () => ({ completionTimeoutMs: 10, handshakeTimeoutMs: 100 }),
      startCandidate: true,
      expected: /delivery timed out/,
    },
  ])("closes the socket on $name timeout", async ({ configure, startCandidate, expected }) => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: { ...shortTimeouts(), ...configure() },
    });
    const request = channelRequest(agent, host.binding);
    const operation = startCandidate
      ? createAgentEnrollmentChannelCandidate({
          request,
          relayBaseUrl: RELAY_URL,
          webSocketFactory: relay.factory,
          timeouts: { ...shortTimeouts(), ...configure() },
        }).deliver(completionFor(agent.publicKey, "trusted"))
      : host.waitForCompletion({
          request,
          authenticate: async () => undefined,
          persist: async () => undefined,
        });

    await expect(operation).rejects.toThrow(expected);
    expect(relay.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("times out persistence without acknowledging and closes the host", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: { ...shortTimeouts(), persistTimeoutMs: 10 },
    });
    const request = channelRequest(agent, host.binding);
    const persist = vi.fn(() => new Promise<void>(() => undefined));
    const received = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: { ...shortTimeouts(), completionTimeoutMs: 1_000 },
    });
    const delivery = candidate.deliver(completionFor(agent.publicKey, "trusted"));
    const receivedResult = expect(received).rejects.toThrow(/persistence timed out/);
    const deliveryResult = expect(delivery).rejects.toThrow(/acknowledgement timed out/);

    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    await receivedResult;
    await deliveryResult;
    expect(relay.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("times out a missing acknowledgement and rejects replay", async () => {
    const relay = new TestRelay("TrustchainAddedMember");
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: shortTimeouts(),
    });
    const request = channelRequest(agent, host.binding);
    const received = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: { ...shortTimeouts(), acknowledgementTimeoutMs: 10 },
    });
    const payload = completionFor(agent.publicKey, "trusted");
    const delivery = candidate.deliver(payload);

    await expect(received).resolves.toBeDefined();
    await expect(delivery).rejects.toThrow(/acknowledgement timed out/);
    expect(() => candidate.deliver(payload)).toThrow(/already been sent/);
    expect(relay.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("caps the host session at signed request expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: { ...shortTimeouts(), completionTimeoutMs: 10_000 },
    });
    const request = createAgentEnrollmentRequest(agent, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "openclaw",
      expiresAt: "2098-01-01T00:00:00.050Z",
      channel: host.binding,
    });
    if (request.version !== "2") throw new Error("expected channel request");
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const result = expect(waiting).rejects.toThrow(/completion timed out/);

    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(relay.sockets[0]?.closed).toBe(true);
  });

  it("persists only once when an encrypted completion is replayed", async () => {
    const relay = new TestRelay(undefined, "TrustchainShareCredential");
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = channelRequest(agent, host.binding);
    const persist = vi.fn(async () => undefined);
    const received = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    await expect(
      candidate.deliver(completionFor(agent.publicKey, "trusted")),
    ).resolves.toBeUndefined();
    await expect(received).resolves.toBeDefined();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("closes on relay errors and when closed before use", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = channelRequest(agent, host.binding);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    relay.sockets[0]?.emit("error");
    await expect(waiting).rejects.toThrow(/connection failed/);
    expect(relay.sockets[0]?.closed).toBe(true);

    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    candidate.close();
    expect(() => candidate.deliver(completionFor(agent.publicKey, "trusted"))).toThrow(/closed/);
  });

  it("matches fixed request, ECDH, KDF, AAD, and AES-GCM vectors", async () => {
    const agent = createSoftwareAgentIdentity("00".repeat(31) + "01");
    const hostIdentity = createSoftwareAgentIdentity("00".repeat(31) + "02");
    const request = createAgentEnrollmentRequest(agent, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "hermes",
      expiresAt: "2099-01-01T00:00:00.000Z",
      channel: { environment: "production", hostPublicKey: hostIdentity.publicKey },
    });
    if (request.version !== "2") throw new Error("expected channel request");
    const sharedSecret = agent.deriveSharedSecret(hexToBytes(hostIdentity.publicKey));
    const metadata = {
      version: 1,
      publisher: agent.publicKey,
      message: "TrustchainShareCredential" as const,
    };

    expect(new TextDecoder().decode(canonicalAgentEnrollmentPayload(request)))
      .toMatchInlineSnapshot(`
      "agent-intent:agent-enrollment:v2
      {"v":"2","publicKey":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","name":"Portfolio Bot","description":"Proposes portfolio operations.","source":"hermes","expiresAt":"2099-01-01T00:00:00.000Z","channelEnvironment":"production","channelHost":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"}"
    `);
    expect(request.signature).toMatchInlineSnapshot(
      `"983103c65349815a637d149fd01c0f239e830982b67db288530a0c45894d77407c665300f70e2e4f2dd7bff6c54ef3f51624d1bc17fb6d63e379b44c76147d25"`,
    );
    expect(Buffer.from(sharedSecret).toString("hex")).toMatchInlineSnapshot(
      `"c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"`,
    );
    expect(enrollmentChannelCryptoVectors.signedRequestDigest(request)).toMatchInlineSnapshot(
      `"fbf94843118e5b25983af1bda5de146c1fce54322146c92f5598505690dafad6"`,
    );
    expect(enrollmentChannelCryptoVectors.deriveKey(sharedSecret, request)).toMatchInlineSnapshot(
      `"8a4aa6d5405d8965542bcd88684f35a71d751ee11f8b0df4dad68ed6ba3f1385"`,
    );
    expect(enrollmentChannelCryptoVectors.aad(request, metadata)).toMatchInlineSnapshot(
      `"{"domain":"agent-intent:enrollment-channel:aad:v1","requestDigest":"fbf94843118e5b25983af1bda5de146c1fce54322146c92f5598505690dafad6","version":1,"publisher":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","message":"TrustchainShareCredential"}"`,
    );
    await expect(
      enrollmentChannelCryptoVectors.encrypt(
        sharedSecret,
        request,
        metadata,
        { completion: '{"version":2}' },
        Uint8Array.from({ length: 12 }, (_, index) => index),
      ),
    ).resolves.toMatchInlineSnapshot(
      `"AAECAwQFBgcICQoLMvG+/mhKzMieRedhRcJ3dCNBHIyYWnInTo8xCgz61w0h1PPhk3DQrBRzdUlm5aYJ"`,
    );
    await expect(
      enrollmentChannelCryptoVectors.encrypt(
        sharedSecret,
        request,
        { ...metadata, message: "TrustchainAddedMember" },
        { completion: '{"version":2}' },
        Uint8Array.from({ length: 12 }, (_, index) => index),
      ),
    ).resolves.not.toBe(
      "AAECAwQFBgcICQoLMvG+/mhKzMieRedhRcJ3dCNBHIyYWnInTo8xCgz61w0h1PPhk3DQrBRzdUlm5aYJ",
    );
  });

  it("does not expose protocol-vector helpers from the package root", () => {
    expect(packageExports).not.toHaveProperty("enrollmentChannelCryptoVectors");
  });
});

function channelRequest(
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

function completionFor(agentPubkey: string, trustchainId: string): string {
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

function shortTimeouts() {
  return {
    candidateTimeoutMs: 100,
    handshakeTimeoutMs: 100,
    completionTimeoutMs: 100,
    acknowledgementTimeoutMs: 100,
    persistTimeoutMs: 100,
  };
}

class TestSocket implements EnrollmentChannelWebSocket {
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
    queueMicrotask(() => this.emit("close"));
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

class TestRelay {
  readonly sockets: TestSocket[] = [];

  constructor(
    private readonly droppedMessage?: string,
    private readonly duplicatedMessage?: string,
  ) {}

  readonly factory: EnrollmentChannelWebSocketFactory = () => {
    const socket = new TestSocket(this);
    this.sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };

  forward(sender: TestSocket, data: string): void {
    const envelope = JSON.parse(data) as { message?: string };
    if (envelope.message === this.droppedMessage) return;
    const host = this.sockets[0];
    const recipients =
      sender === host ? this.sockets.slice(1).filter((socket) => !socket.closed) : [host];
    for (const recipient of recipients) {
      if (recipient && !recipient.closed) {
        queueMicrotask(() => recipient.emit("message", { data }));
        if (envelope.message === this.duplicatedMessage) {
          queueMicrotask(() => recipient.emit("message", { data }));
        }
      }
    }
  }
}
