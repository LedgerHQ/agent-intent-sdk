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
import { createAgentRecoveryRequest, serializeAgentRecoveryCompletion } from "./recovery.ts";

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
    expect(() => validCandidate.deliver(completionFor(agent.publicKey, "trusted"))).toThrow(
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
      open: 1,
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

  it("times out a missing acknowledgement and fails a retry once the host is gone", async () => {
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
    await expect(candidate.deliver(payload)).rejects.toThrow(/timed out/);
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

  it("connects before device approval and delivers over the same session afterwards", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const timeouts = {
      ...shortTimeouts(),
      candidateTimeoutMs: 200,
      completionTimeoutMs: 10 * 60_000,
    };
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const request = channelRequest(agent, host.binding);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });

    const connected = candidate.connect();
    await vi.advanceTimersByTimeAsync(0);
    await expect(connected).resolves.toBeUndefined();
    await expect(candidate.connect()).resolves.toBeUndefined();
    expect(relay.sockets).toHaveLength(2);

    // Device approval: far beyond the handshake and candidate windows.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(relay.sockets.some((socket) => socket.closed)).toBe(false);

    const delivering = candidate.deliver(completionFor(agent.publicKey, "trusted"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(delivering).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ trustchainId: "trusted" });
    expect(relay.sockets).toHaveLength(2);
  });

  it("bounds an idle connected session by the completion timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const timeouts = { ...shortTimeouts(), completionTimeoutMs: 1_000 };
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const request = channelRequest(agent, host.binding);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const hostResult = expect(waiting).rejects.toThrow(/completion timed out/);
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const connected = candidate.connect();
    await vi.advanceTimersByTimeAsync(0);
    await connected;

    await vi.advanceTimersByTimeAsync(1_000);
    await hostResult;
    expect(relay.sockets.every((socket) => socket.closed)).toBe(true);
  });

  it("keeps both relay sockets past the relay's 5-minute idle timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    relay.idleTimeoutMs = 5 * 60_000;
    const agent = createSoftwareAgentIdentity();
    const timeouts = {
      ...shortTimeouts(),
      candidateTimeoutMs: 30 * 60_000,
      completionTimeoutMs: 30 * 60_000,
    };
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const request = channelRequest(agent, host.binding);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });

    // The user takes a while to open the enrollment link.
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(relay.sockets[0]?.closed).toBe(false);

    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const connected = candidate.connect();
    await vi.advanceTimersByTimeAsync(0);
    await expect(connected).resolves.toBeUndefined();

    // Ledger Sync activation and device approval take longer than the relay idle timeout too.
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(relay.sockets.some((socket) => socket.closed)).toBe(false);

    const delivering = candidate.deliver(completionFor(agent.publicKey, "trusted"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(delivering).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ trustchainId: "trusted" });

    const pingsAtCompletion = relay.pings;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(relay.pings).toBe(pingsAtCompletion);
  });

  it("stops pinging the relay once a session fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: {
        ...shortTimeouts(),
        candidateTimeoutMs: 2 * 60_000,
        completionTimeoutMs: 2 * 60_000,
      },
    });
    const waiting = host.waitForCompletion({
      request: channelRequest(agent, host.binding),
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const hostResult = expect(waiting).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await hostResult;
    const pingsAtFailure = relay.pings;
    expect(pingsAtFailure).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(relay.pings).toBe(pingsAtFailure);
  });

  it("stops pinging when the host closes over a socket that never reports close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    relay.socketsEmitClose = false;
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts: {
        ...shortTimeouts(),
        candidateTimeoutMs: 30 * 60_000,
        completionTimeoutMs: 30 * 60_000,
      },
    });
    const waiting = host.waitForCompletion({
      request: channelRequest(agent, host.binding),
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const hostResult = expect(waiting).rejects.toThrow(/has been closed/);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(relay.pings).toBeGreaterThan(0);
    host.close();
    await hostResult;
    const pingsAtClose = relay.pings;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(relay.pings).toBe(pingsAtClose);
  });

  it("ignores relay pong replies delivered as binary frames", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
    const relay = new TestRelay();
    relay.binaryFrames = true;
    const agent = createSoftwareAgentIdentity();
    const timeouts = { ...shortTimeouts(), completionTimeoutMs: 30 * 60_000 };
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const request = channelRequest(agent, host.binding);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist: async () => undefined,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
      timeouts,
    });
    const connected = candidate.connect();
    await vi.advanceTimersByTimeAsync(0);
    await expect(connected).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(relay.pings).toBeGreaterThan(0);

    const delivering = candidate.deliver(completionFor(agent.publicKey, "trusted"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(delivering).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ trustchainId: "trusted" });
  });

  it("reconnects implicitly when the relay drops the session before delivery", async () => {
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
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    await candidate.connect();
    relay.sockets[1]?.close();
    await vi.waitFor(() => expect(relay.sockets[1]?.closed).toBe(true));

    await expect(
      candidate.deliver(completionFor(agent.publicKey, "trusted")),
    ).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ trustchainId: "trusted" });
    expect(relay.sockets).toHaveLength(3);
  });

  it("retries delivery on the same candidate after the host rejects it", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = channelRequest(agent, host.binding);
    const authenticate = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Keycloak unavailable"))
      .mockResolvedValue(undefined);
    const persist = vi.fn(async () => undefined);
    const waiting = host.waitForCompletion({ request, authenticate, persist });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const payload = completionFor(agent.publicKey, "trusted");

    await candidate.connect();
    await expect(candidate.deliver(payload)).rejects.toThrow(/host rejected/);
    expect(persist).not.toHaveBeenCalled();

    await expect(candidate.deliver(payload)).resolves.toBeUndefined();
    await expect(waiting).resolves.toMatchObject({ trustchainId: "trusted" });
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledOnce();
    expect(() => candidate.deliver(payload)).toThrow(/already been sent/);
    expect(() => candidate.connect()).toThrow(/already been sent/);
  });

  it("rejects concurrent deliveries and connecting after close", async () => {
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
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const payload = completionFor(agent.publicKey, "trusted");

    const delivering = candidate.deliver(payload);
    expect(() => candidate.deliver(payload)).toThrow(/already being sent/);
    await delivering;
    await waiting;

    const closedCandidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    closedCandidate.close();
    expect(() => closedCandidate.connect()).toThrow(/closed/);
  });

  it("delivers a recovery completion over a recovery request's channel", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = recoveryChannelRequest(agent, host.binding);
    const persist = vi.fn(async (completion: { recovery: true; trustchainId: string }) => {
      expect(completion.recovery).toBe(true);
    });
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist,
    });
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    await candidate.connect();
    await expect(
      candidate.deliver(
        serializeAgentRecoveryCompletion({
          agentPubkey: agent.publicKey,
          previousTrustchainId: "app-18-root",
          requestSignature: request.signature,
          trustchainId: "app-18-root",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(waiting).resolves.toEqual({
      version: 3,
      recovery: true,
      agentPubkey: agent.publicKey,
      previousTrustchainId: "app-18-root",
      requestSignature: request.signature,
      trustchainId: "app-18-root",
    });
    expect(persist).toHaveBeenCalledOnce();
  });

  it("rejects completions that do not match the channel request kind", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = recoveryChannelRequest(agent, host.binding);
    const persist = vi.fn(async () => undefined);
    const waiting = host.waitForCompletion({
      request,
      authenticate: async () => undefined,
      persist,
    });
    const hostFailure = vi.fn();
    void waiting.catch(hostFailure);
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    await expect(candidate.deliver(completionFor(agent.publicKey, "app-18-root"))).rejects.toThrow(
      /host rejected/,
    );
    await expect(
      candidate.deliver(
        serializeAgentRecoveryCompletion({
          agentPubkey: agent.publicKey,
          previousTrustchainId: "app-18-root",
          requestSignature: "ab".repeat(64),
          trustchainId: "app-18-root",
        }),
      ),
    ).rejects.toThrow(/host rejected/);
    expect(persist).not.toHaveBeenCalled();
    expect(hostFailure).not.toHaveBeenCalled();
    host.close();
  });

  it("requires a channel binding on recovery requests", () => {
    const agent = createSoftwareAgentIdentity();
    const request = createAgentRecoveryRequest(agent, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "openclaw",
      previousTrustchainId: "app-18-root",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(() =>
      createAgentEnrollmentChannelCandidate({
        request: request as Parameters<typeof createAgentEnrollmentChannelCandidate>[0]["request"],
        relayBaseUrl: RELAY_URL,
        webSocketFactory: new TestRelay().factory,
      }),
    ).toThrow(/requires an enrollment channel request/);
  });

  it("binds recovery channel keys to the signed recovery request", () => {
    const agent = createSoftwareAgentIdentity("00".repeat(31) + "01");
    const hostIdentity = createSoftwareAgentIdentity("00".repeat(31) + "02");
    const request = recoveryChannelRequest(agent, {
      environment: "production",
      hostPublicKey: hostIdentity.publicKey,
    });
    const sharedSecret = agent.deriveSharedSecret(hexToBytes(hostIdentity.publicKey));

    expect(request.signature).toMatchInlineSnapshot(
      `"c2e202c6541d321330299d1dcea72653bc3898d068e06c68bef704dacb46acf670a8d73d8865fda940ce5d60d73f6c4312ad66ac11a8d736a0a36e14bacb7052"`,
    );
    expect(enrollmentChannelCryptoVectors.signedRequestDigest(request)).toMatchInlineSnapshot(
      `"08c6829e3d5e5d1f7d2151e7dd4dcc102266025cb7f665a75beb347e38742994"`,
    );
    expect(enrollmentChannelCryptoVectors.deriveKey(sharedSecret, request)).toMatchInlineSnapshot(
      `"69bfe9b5e4be0cc413632e433e03cb77adeeb44e3aef1ec20f51f518c9cb96a1"`,
    );
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

function recoveryChannelRequest(
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
    if (this.relay.socketsEmitClose) queueMicrotask(() => this.emit("close"));
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
  /** Like the Trustchain relay: drop a socket after this long without a frame sent to it. */
  idleTimeoutMs: number | undefined;
  pings = 0;
  /** Deliver frames as Buffers, like some Node WebSocket clients. */
  binaryFrames = false;
  /** Whether a closed socket emits a close event; custom factories might not. */
  socketsEmitClose = true;
  private readonly idleTimers = new Map<TestSocket, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly droppedMessage?: string,
    private readonly duplicatedMessage?: string,
  ) {}

  readonly factory: EnrollmentChannelWebSocketFactory = () => {
    const socket = new TestSocket(this);
    this.sockets.push(socket);
    this.touch(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };

  forward(sender: TestSocket, data: string): void {
    if (data === "ping") {
      this.pings += 1;
      this.deliver(sender, "pong");
      return;
    }
    const envelope = JSON.parse(data) as { message?: string };
    if (envelope.message === this.droppedMessage) return;
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

  private deliver(recipient: TestSocket, data: string): void {
    this.touch(recipient);
    const frame = this.binaryFrames ? Buffer.from(data) : data;
    queueMicrotask(() => recipient.emit("message", { data: frame }));
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
