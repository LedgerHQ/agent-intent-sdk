import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentIntentSdkError, hexToBytes } from "./bytes.ts";
import { serializeAgentEnrollmentCompletion } from "./completion.ts";
import {
  agentEnrollmentSearch,
  canonicalAgentEnrollmentPayload,
  createAgentEnrollmentRequest,
  validateAgentEnrollment,
} from "./enrollment.ts";
import {
  AGENT_ENROLLMENT_CHANNEL_DEFAULT_TIMEOUTS,
  AgentEnrollmentRejectedError,
  createAgentEnrollmentChannelCandidate,
  createAgentEnrollmentChannelHost,
  enrollmentChannelCryptoVectors,
  isAgentEnrollmentRejectedError,
  type AgentEnrollmentChannelRequest,
  type AgentEnrollmentChannelTimeouts,
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

    // Whole relay frames: a completion and a rejection travel as TrustchainShareCredential, their
    // acknowledgements as TrustchainAddedMember, and the host's refusals as a Failure whose
    // `message` carries the ciphertext.
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => index);
    const fromHost = { ...metadata, publisher: hostIdentity.publicKey };
    const acknowledgement = { ...fromHost, message: "TrustchainAddedMember" as const };
    const refusal = { ...fromHost, message: "Failure" as const };
    expect(enrollmentChannelCryptoVectors.aad(request, acknowledgement)).toMatchInlineSnapshot(
      `"{"domain":"agent-intent:enrollment-channel:aad:v1","requestDigest":"fbf94843118e5b25983af1bda5de146c1fce54322146c92f5598505690dafad6","version":1,"publisher":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5","message":"TrustchainAddedMember"}"`,
    );
    expect(enrollmentChannelCryptoVectors.aad(request, refusal)).toMatchInlineSnapshot(
      `"{"domain":"agent-intent:enrollment-channel:aad:v1","requestDigest":"fbf94843118e5b25983af1bda5de146c1fce54322146c92f5598505690dafad6","version":1,"publisher":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5","message":"Failure"}"`,
    );
    const frame = (
      envelope: typeof metadata | typeof acknowledgement | typeof refusal,
      payload: object,
    ) => enrollmentChannelCryptoVectors.envelope(sharedSecret, request, envelope, payload, nonce);
    expect({
      completion: await frame(metadata, { completion: '{"version":2}' }),
      rejection: await frame(metadata, { reason: "user-rejected" }),
      "rejection-acknowledged": await frame(acknowledgement, { reason: "rejection-acknowledged" }),
      "completion-received": await frame(refusal, { reason: "completion-received" }),
      reset: await frame(refusal, { reason: "reset" }),
    }).toMatchInlineSnapshot(`
      {
        "completion": "{"version":1,"publisher":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","message":"TrustchainShareCredential","payload":{"encrypted":"AAECAwQFBgcICQoLMvG+/mhKzMieRedhRcJ3dCNBHIyYWnInTo8xCgz61w0h1PPhk3DQrBRzdUlm5aYJ"}}",
        "completion-received": "{"version":1,"publisher":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5","message":"Failure","payload":{"type":"UNEXPECTED_SHARE_CREDENTIAL","message":"AAECAwQFBgcICQoLMvGv9GRJz8PIFqpsCJUlYxoXA4aEBGktQ7Z6Rlvj1w2WkJ2VFTrWinCYYKWb7SmQ"}}",
        "rejection": "{"version":1,"publisher":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","message":"TrustchainShareCredential","payload":{"encrypted":"AAECAwQFBgcICQoLMvGv9GRJz8PIFqp6FJ0nIg0GAIyJXX4sAq68ATs5JWM53xvX88MuVlq+"}}",
        "rejection-acknowledged": "{"version":1,"publisher":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5","message":"TrustchainAddedMember","payload":{"encrypted":"AAECAwQFBgcICQoLMvGv9GRJz8PIFqp9ApIwbAsKBYfHSHgjTrxkXFvjkhVLIV8JfPpnwaa9BIJr0pIi/MMs"}}",
        "reset": "{"version":1,"publisher":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5","message":"Failure","payload":{"type":"UNEXPECTED_SHARE_CREDENTIAL","message":"AAECAwQFBgcICQoLMvGv9GRJz8PIFqp9Aoswe10eYUebMEJWG0Vl7o6LvAr4qg=="}}",
      }
    `);
  });

  it("does not expose protocol-vector helpers from the package root", () => {
    expect(packageExports).not.toHaveProperty("enrollmentChannelCryptoVectors");
  });

  it("reports the relay's own Failure before checking the host key", async () => {
    const relay = new TestRelay();
    const agent = createSoftwareAgentIdentity();
    const host = createAgentEnrollmentChannelHost({
      environment: "production",
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });
    const request = channelRequest(agent, host.binding);
    const candidate = createAgentEnrollmentChannelCandidate({
      request,
      relayBaseUrl: RELAY_URL,
      webSocketFactory: relay.factory,
    });

    // The relay answers a candidate that has no host with its own unencrypted Failure.
    const connecting = candidate.connect();
    relay.sockets[0]?.emit("message", { data: JSON.stringify(relayFailure()) });
    await expect(connecting).rejects.toThrow("The enrollment relay rejected the session.");
    expect(relay.sockets[0]?.closed).toBe(true);
  });

  describe("host reconnect", () => {
    it("reopens the host socket at once after its candidate leaves and accepts a new candidate", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();

      await setup.leave();
      expect(setup.relay.hostSockets[0]?.closed).toBe(true);
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(setup.relay.hostSockets[1]?.closed).toBe(false);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-reconnect")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-reconnect" });
      expect(setup.persist).toHaveBeenCalledOnce();
    });

    it("closes a host socket that errored without closing", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      await setup.candidate().connect();

      setup.relay.hostSockets[0]?.emit("error");
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets[0]?.closed).toBe(true);
      expect(setup.relay.hostSockets).toHaveLength(2);
      // The relay evicts the candidate of the abandoned socket, so it cannot hold the channel.
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(setup.relay.sockets[1]?.closed).toBe(true);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-error")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-error" });
    });

    it("backs off a relay that closes each socket right after it opens", async () => {
      const setup = pairedHost();
      const { isSettled } = setup.start();
      await vi.advanceTimersByTimeAsync(0);

      // Every socket opens before it is closed, so an open alone must not restart the backoff.
      setup.relay.hostSockets[0]?.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets).toHaveLength(2);
      for (const delay of [1_000, 2_000, 4_000, 5_000, 5_000]) {
        expect(setup.relay.hostSockets.at(-1)?.closed).toBe(false);
        setup.relay.hostSockets.at(-1)?.close();
        await expectNextSocketAfter(setup, delay);
      }
      expect(isSettled()).toBe(false);
    });

    it("retries a reconnect socket that fails to open after 1, 2 and 4 seconds, then every 5 seconds", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      setup.relay.refuseNextSockets = 6;

      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);
      for (const delay of [1_000, 2_000, 4_000, 5_000, 5_000, 5_000]) {
        const attempts = setup.relay.hostSockets.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(setup.relay.hostSockets).toHaveLength(attempts);
        await vi.advanceTimersByTimeAsync(1);
        expect(setup.relay.hostSockets).toHaveLength(attempts + 1);
      }
      expect(setup.relay.hostSockets[7]?.closed).toBe(false);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-retries")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-retries" });
    });

    it("does not restart the backoff when a reopened socket opens", async () => {
      const setup = pairedHost();
      const { isSettled } = setup.start();

      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(setup.relay.hostSockets[1]?.closed).toBe(false);
      await setup.leave();
      await expectNextSocketAfter(setup, 1_000);
      expect(setup.relay.hostSockets[2]?.closed).toBe(false);
      expect(isSettled()).toBe(false);
    });

    it("reconnects at once after each drop of a socket open 60 s", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();

      for (let round = 0; round < 7; round += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await setup.leave();
        expect(setup.relay.hostSockets).toHaveLength(round + 2);
      }
      expect(setup.relay.hostSockets).toHaveLength(8);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "slow-visits")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "slow-visits" });
    });

    it.each([
      { openMs: 59_999, delayMs: 1_000 },
      { openMs: 60_000, delayMs: 0 },
    ])(
      "reopens $delayMs ms after a drop of a socket open $openMs ms",
      async ({ openMs, delayMs }) => {
        const setup = pairedHost();
        setup.start();
        await setup.leave();

        // The second socket opened as the first drop landed; leave() drops it peerCloseDelayMs later.
        await vi.advanceTimersByTimeAsync(openMs - setup.relay.peerCloseDelayMs);
        await setup.leave();
        if (delayMs > 0) await expectNextSocketAfter(setup, delayMs);
        else expect(setup.relay.hostSockets).toHaveLength(3);
      },
    );

    it("reopens the host when a candidate goes silent during the handshake", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), handshakeTimeoutMs: 30_000 });
      // The handshake timeout must not wait for a close event that some sockets never send.
      setup.relay.socketsEmitClose = false;
      const { waiting } = setup.start();

      const silent = await silentCandidate(setup);
      await vi.advanceTimersByTimeAsync(30_000 - 1);
      expect(setup.relay.hostSockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(setup.relay.hostSockets[0]?.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(silent.closed).toBe(true);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-silence")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-silence" });
    });

    it("advances the reconnect backoff on a handshake timeout", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), handshakeTimeoutMs: 30_000 });
      setup.start();

      await silentCandidate(setup);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      await setup.leave();
      await expectNextSocketAfter(setup, 1_000);
    });

    it("re-arms the candidate wait after a handshake timeout", async () => {
      const setup = pairedHost({
        ...reconnectTimeouts(),
        handshakeTimeoutMs: 30_000,
        candidateTimeoutMs: 10_000,
      });
      const { waiting, isSettled } = setup.start();

      await silentCandidate(setup);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/waiting for the frontend candidate/);
    });

    it("measures the stable window from the reconnect socket's open, not the drop before it", async () => {
      const setup = pairedHost();
      setup.start();
      // The reconnect fails at 0, 1 and 3 s and opens at 7 s.
      setup.relay.refuseNextSockets = 3;
      await setup.leave();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(setup.relay.hostSockets).toHaveLength(5);
      expect(setup.relay.hostSockets[4]?.closed).toBe(false);

      // Open for 55 s, 62 s after the drop that started the reconnect: the backoff goes on.
      await vi.advanceTimersByTimeAsync(55_000);
      setup.relay.hostSockets[4]?.close();
      await expectNextSocketAfter(setup, 5_000);
    });

    it("measures the stable window from the open event, not from socket creation", async () => {
      let created = 0;
      const setup = pairedHost(reconnectTimeouts(), (factory) => (url) => {
        created += 1;
        const socket = factory(url) as TestSocket;
        if (created === 2) {
          // This socket reports open 7 s after it was created.
          const add = socket.addEventListener.bind(socket);
          socket.addEventListener = (
            type: "open" | "message" | "error" | "close",
            listener: never,
          ) => add(type, (type === "open" ? () => setTimeout(listener, 7_000) : listener) as never);
        }
        return socket;
      });
      setup.start();
      await setup.leave();

      await vi.advanceTimersByTimeAsync(7_000 + 55_000);
      setup.relay.hostSockets[1]?.close();
      await expectNextSocketAfter(setup, 1_000);
    });

    it("continues the backoff after a reopen that hung for 60 s and failed", async () => {
      const setup = pairedHost();
      const { isSettled } = setup.start();
      // A socket that never opened must not restart the backoff, however long it hung.
      setup.relay.refuseNextSockets = 1;
      setup.relay.refuseDelayMs = 60_000;
      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await expectNextSocketAfter(setup, 1_000);
      expect(setup.relay.hostSockets[2]?.closed).toBe(false);
      expect(isSettled()).toBe(false);
    });

    it("keeps retrying until the request expires", async () => {
      const setup = pairedHost();
      vi.setSystemTime(new Date("2098-12-31T23:50:00.000Z"));
      const { waiting, isSettled } = setup.start();
      await vi.advanceTimersByTimeAsync(0);
      setup.relay.refuseNextSockets = 1_000;
      setup.relay.hostSockets[0]?.close();

      await vi.advanceTimersByTimeAsync(10 * 60_000 - 5_001);
      const attempts = setup.relay.hostSockets.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(setup.relay.hostSockets.length).toBeGreaterThan(attempts);
      expect(isSettled()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toMatchObject({ message: "Enrollment completion timed out." });
      expect(vi.getTimerCount()).toBe(0);
      const sockets = setup.relay.hostSockets.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(setup.relay.hostSockets).toHaveLength(sockets);
    });

    it("retries a reconnect whose socket throws while its listeners are added", async () => {
      let created = 0;
      const setup = pairedHost(reconnectTimeouts(), (factory) => (url) => {
        created += 1;
        const socket = factory(url) as TestSocket;
        if (created === 2) {
          const add = socket.addEventListener.bind(socket);
          socket.addEventListener = (
            type: "open" | "message" | "error" | "close",
            listener: never,
          ) => {
            if (type === "message") throw new Error("listener failed");
            add(type, listener);
          };
        }
        return socket;
      });
      const { waiting } = setup.start();

      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.relay.hostSockets).toHaveLength(3);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-listener-throw")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-listener-throw" });
    });

    it("leaves no timer when authenticate rejects after the host closed", async () => {
      const setup = pairedHost();
      let rejectAuthentication: () => void = () => undefined;
      setup.authenticate.mockImplementation(
        () =>
          new Promise<undefined>(
            (_, reject) => (rejectAuthentication = () => reject(new Error("denied"))),
          ),
      );
      const { waiting } = setup.start();
      const candidate = setup.candidate();
      void candidate.deliver(completionFor(setup.agent.publicKey, "late")).catch(() => undefined);
      await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce());
      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      candidate.close();
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);

      // The host answers the rejected completion with an encrypted Failure on its closed socket.
      const hostSocket = setup.relay.hostSockets[0]!;
      const send = hostSocket.send.bind(hostSocket);
      const failureSent = new Promise<void>((resolve) => {
        hostSocket.send = (data) => {
          try {
            send(data);
          } finally {
            resolve();
          }
        };
      });
      rejectAuthentication();
      await failureSent;
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops reconnecting once the request has expired by the wall clock", async () => {
      const setup = pairedHost();
      const { waiting, isSettled } = setup.start();
      await vi.advanceTimersByTimeAsync(0);

      // Like a laptop waking from sleep: the wall clock passed expiry, but no timer fired yet.
      vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
      setup.relay.hostSockets[0]?.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(isSettled()).toBe(true);
      await expect(waiting).rejects.toMatchObject({ message: "Enrollment completion timed out." });
      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not retry a failed open once the request has expired by the wall clock", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      setup.relay.refuseNextSockets = 99;
      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);

      vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(waiting).rejects.toMatchObject({ message: "Enrollment completion timed out." });
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("measures the stable window on a monotonic clock", async () => {
      const setup = pairedHost();
      setup.start();
      await setup.leave();

      vi.setSystemTime(Date.now() + 10 * 60_000);
      await setup.leave();
      await expectNextSocketAfter(setup, 1_000);
    });

    it("leaves no timer when a connecting reopen fails after the host closed", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      setup.relay.refuseNextSockets = 1;
      setup.relay.refuseDelayMs = 500;
      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(100);
      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      await vi.advanceTimersByTimeAsync(400);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("fails at once when the initial host socket never opens", async () => {
      const setup = pairedHost();
      setup.relay.refuseNextSockets = 1;
      const { waiting } = setup.start();

      await expect(waiting).rejects.toThrow(/connection failed/);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(setup.relay.hostSockets).toHaveLength(1);
    });

    it.each(["authenticate", "persist"] as const)(
      "does not reopen the host while a completion is in %s",
      async (phase) => {
        const setup = pairedHost();
        setup[phase].mockImplementation(() => new Promise<undefined>(() => undefined));
        const { waiting } = setup.start();
        const candidate = setup.candidate();
        void candidate
          .deliver(completionFor(setup.agent.publicKey, "trusted"))
          .catch(() => undefined);
        await vi.waitFor(() => expect(setup[phase]).toHaveBeenCalledOnce());

        candidate.close();
        await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
        await expect(waiting).rejects.toMatchObject({
          message: "Enrollment relay closed before completion was acknowledged.",
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(setup.relay.hostSockets).toHaveLength(1);
      },
    );

    it("keeps the completion deadline while a reconnect is pending", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), completionTimeoutMs: 10_000 });
      const { waiting, isSettled } = setup.start();
      setup.relay.refuseNextSockets = 99;

      // The drop lands at 1.1 s; retries follow at 2.1, 4.1 and 8.1 s, the next would be 13.1 s.
      await setup.leave();
      await vi.advanceTimersByTimeAsync(10_000 - setup.relay.peerCloseDelayMs - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/completion timed out/);
      expect(setup.relay.hostSockets).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(setup.relay.hostSockets).toHaveLength(5);
    });

    it("does not extend the completion deadline when the host reconnects", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), completionTimeoutMs: 10_000 });
      const { waiting, isSettled } = setup.start();

      await vi.advanceTimersByTimeAsync(5_000);
      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000 - 5_000 - setup.relay.peerCloseDelayMs - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/completion timed out/);
    });

    it("opens no socket when the host is closed during a pending retry", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      setup.relay.refuseNextSockets = 1;

      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(500);
      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      expect(vi.getTimerCount()).toBe(0);
      const pings = setup.relay.pings;

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(setup.relay.sockets.every((socket) => socket.closed)).toBe(true);
      expect(setup.relay.pings).toBe(pings);
    });

    it("stops reconnecting once the host is closed", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      await vi.advanceTimersByTimeAsync(0);

      setup.relay.hostSockets[0]?.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets).toHaveLength(2);
      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(setup.relay.hostSockets.every((socket) => socket.closed)).toBe(true);
    });

    it("opens no socket when the host closes while a reconnect is queued", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      // The drop queues the reconnect behind the handshake handler that is still running.
      setup.relay.onSend = (sender, message) => {
        if (message !== "HandshakeCompletionSucceeded") return;
        sender.drop();
        setup.host.close();
      };

      void setup
        .candidate()
        .connect()
        .catch(() => undefined);
      await expect(waiting).rejects.toThrow(/has been closed/);
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("opens no socket when the host closes during a reconnect delay", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      await setup.leave();
      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(500);
      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
    });

    it("ignores events from a replaced host socket", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      await setup.leave();
      const second = setup.candidate();
      await second.connect();

      const replaced = setup.relay.hostSockets[0];
      replaced?.emit("close");
      replaced?.emit("message", { data: JSON.stringify(relayFailure()) });
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets).toHaveLength(2);

      await expect(
        second.deliver(completionFor(setup.agent.publicKey, "current-socket")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "current-socket" });
    });

    it("lets a candidate that arrives before the host is back retry", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      const first = setup.candidate();
      await first.connect();
      first.close();

      // The relay has not closed the host yet, so this candidate finds the channel without one.
      const second = setup.candidate();
      await expect(second.connect()).rejects.toThrow("The enrollment relay rejected the session.");
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(setup.relay.hostSockets).toHaveLength(2);

      await expect(
        second.deliver(completionFor(setup.agent.publicKey, "second-try")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "second-try" });
    });

    it("keeps the candidate wait when the relay drops a host that has no candidate", async () => {
      const setup = pairedHost({
        ...reconnectTimeouts(),
        candidateTimeoutMs: 10_000,
        completionTimeoutMs: 60_000,
      });
      const { waiting, isSettled } = setup.start();

      await vi.advanceTimersByTimeAsync(5_000);
      setup.relay.hostSockets[0]?.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/waiting for the frontend candidate/);
    });

    it("drops a completion that was queued when the relay dropped the host", async () => {
      const setup = pairedHost();
      const { waiting, isSettled } = setup.start();
      const first = setup.candidate();
      await first.connect();

      setup.relay.dropRecipientAfter = "TrustchainShareCredential";
      void first.deliver(completionFor(setup.agent.publicKey, "dropped")).catch(() => undefined);
      await vi.waitFor(() => expect(setup.relay.hostSockets).toHaveLength(2));
      setup.relay.dropRecipientAfter = undefined;
      expect(setup.authenticate).not.toHaveBeenCalled();
      expect(setup.persist).not.toHaveBeenCalled();
      expect(isSettled()).toBe(false);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-drop")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-drop" });
    });

    it("re-arms the candidate wait after a drop once a candidate was authenticated", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), candidateTimeoutMs: 10_000 });
      const { waiting, isSettled } = setup.start();

      await setup.leave();
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/waiting for the frontend candidate/);
    });

    it("re-arms the candidate wait after a drop during the handshake", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), candidateTimeoutMs: 10_000 });
      const { waiting, isSettled } = setup.start();
      setup.relay.dropRecipientAfter = "HandshakeChallenge";

      await setup
        .candidate()
        .connect()
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/waiting for the frontend candidate/);
    });

    it("reconnects only after the handshake handler that saw the drop finishes", async () => {
      const setup = pairedHost({ ...reconnectTimeouts(), candidateTimeoutMs: 10_000 });
      const { waiting, isSettled } = setup.start();
      const dropped = new Promise<void>((resolve) => {
        setup.relay.onSend = (sender, message) => {
          if (message !== "HandshakeCompletionSucceeded") return;
          sender.drop();
          resolve();
        };
      });

      void setup
        .candidate()
        .connect()
        .catch(() => undefined);
      await dropped;
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/waiting for the frontend candidate/);
    });

    it("keeps the candidate wait while failed reopens are retried", async () => {
      const setup = pairedHost({
        ...reconnectTimeouts(),
        candidateTimeoutMs: 10_000,
        completionTimeoutMs: 60_000,
      });
      const { waiting, isSettled } = setup.start();

      await vi.advanceTimersByTimeAsync(5_000);
      setup.relay.refuseNextSockets = 3;
      setup.relay.hostSockets[0]?.close();
      await vi.advanceTimersByTimeAsync(5_000 - 1);
      expect(setup.relay.hostSockets).toHaveLength(4);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).rejects.toThrow(/waiting for the frontend candidate/);
    });

    it("leaves no timer behind after reconnecting twice and delivering", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      await setup.leave();
      await setup.leave();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "third-visit")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "third-visit" });
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not ping from a reopened socket that opens after it failed", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      setup.relay.refuseNextSockets = 1;
      await setup.leave();
      setup.relay.hostSockets[1]?.emit("open");
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "late-open")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "late-open" });
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retries a reconnect whose socket factory throws", async () => {
      let calls = 0;
      const setup = pairedHost(reconnectTimeouts(), (factory) => (url) => {
        calls += 1;
        if (calls === 2) throw new Error("socket factory failed");
        return factory(url);
      });
      const { waiting } = setup.start();

      await setup.leave();
      expect(setup.relay.hostSockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(setup.relay.hostSockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.relay.hostSockets).toHaveLength(2);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-throw")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-throw" });
    });

    it("stays closed when the host is closed while a handshake is being confirmed", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      // Like undici and ws, the close event arrives after the closing handshake.
      setup.relay.closeEventDelayMs = 100;
      setup.relay.onSend = (_sender, message) => {
        if (message === "HandshakeCompletionSucceeded") setup.host.close();
      };

      void setup
        .candidate()
        .connect()
        .catch(() => undefined);
      await expect(waiting).rejects.toThrow(/has been closed/);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not persist a completion once the host closed during authentication", async () => {
      const setup = pairedHost();
      let authenticated: () => void = () => undefined;
      setup.authenticate.mockImplementation(
        () => new Promise<undefined>((resolve) => (authenticated = () => resolve(undefined))),
      );
      const { waiting } = setup.start();
      const candidate = setup.candidate();
      void candidate.deliver(completionFor(setup.agent.publicKey, "late")).catch(() => undefined);
      await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce());

      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      authenticated();
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.persist).not.toHaveBeenCalled();
    });

    it("keeps pinging on a reopened socket", async () => {
      const setup = pairedHost();
      setup.relay.idleTimeoutMs = 5 * 60_000;
      setup.start();
      await setup.leave();
      const pings = setup.relay.pings;

      await vi.advanceTimersByTimeAsync(7 * 60_000);
      expect(setup.relay.hostSockets).toHaveLength(2);
      expect(setup.relay.hostSockets[1]?.closed).toBe(false);
      expect(setup.relay.pings).toBeGreaterThan(pings);
    });

    it("treats a ping left unanswered for 10 seconds as a drop", async () => {
      const setup = pairedHost();
      // Like a half-open socket: pings leave, nothing comes back, and no close is reported.
      setup.relay.answerPings = false;
      const { waiting } = setup.start();

      // The first ping goes out at 60 s.
      await vi.advanceTimersByTimeAsync(70_000 - 1);
      expect(setup.relay.hostSockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.relay.hostSockets[0]?.closed).toBe(true);
      expect(setup.relay.hostSockets).toHaveLength(2);

      setup.relay.answerPings = true;
      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-silence")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-silence" });
    });

    it("treats an unanswered ping on a reopened socket as a drop", async () => {
      const setup = pairedHost();
      setup.start();
      await setup.leave();
      setup.relay.answerPings = false;

      await vi.advanceTimersByTimeAsync(70_000 - 1);
      expect(setup.relay.hostSockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.relay.hostSockets[1]?.closed).toBe(true);
      expect(setup.relay.hostSockets).toHaveLength(3);
    });

    it("expects a reply to every ping, not only the first", async () => {
      const setup = pairedHost();
      setup.start();
      await vi.advanceTimersByTimeAsync(60_000);
      setup.relay.answerPings = false;

      await vi.advanceTimersByTimeAsync(70_000 - 1);
      expect(setup.relay.hostSockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.relay.hostSockets[0]?.closed).toBe(true);
      expect(setup.relay.hostSockets).toHaveLength(2);
    });

    it("keeps a socket whose pongs arrive", async () => {
      const setup = pairedHost();
      setup.start();

      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(setup.relay.pings).toBe(3);
      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(setup.relay.hostSockets[0]?.closed).toBe(false);
    });

    it("keeps a socket that receives any other frame after a ping", async () => {
      const setup = pairedHost();
      setup.relay.answerPings = false;
      setup.start();

      await vi.advanceTimersByTimeAsync(65_000);
      await setup.candidate().connect();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(setup.relay.hostSockets[0]?.closed).toBe(false);
    });

    it("fails when a ping goes unanswered while a completion is being authenticated", async () => {
      const setup = pairedHost();
      setup.authenticate.mockImplementation(() => new Promise<undefined>(() => undefined));
      const { waiting } = setup.start();
      void setup
        .candidate()
        .deliver(completionFor(setup.agent.publicKey, "trusted"))
        .catch(() => undefined);
      await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce());
      setup.relay.answerPings = false;
      const result = expect(waiting).rejects.toMatchObject({
        message: "Enrollment relay closed before completion was acknowledged.",
      });

      await vi.advanceTimersByTimeAsync(70_000);
      await result;
      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(setup.relay.hostSockets[0]?.closed).toBe(true);
    });

    it("clears the reply deadline of a socket the relay dropped", async () => {
      const setup = pairedHost();
      setup.relay.answerPings = false;
      const { waiting } = setup.start();
      await vi.advanceTimersByTimeAsync(60_000);

      setup.relay.hostSockets[0]?.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.relay.hostSockets).toHaveLength(2);
      setup.relay.answerPings = true;
      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-drop")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-drop" });
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the reply deadline when the host is closed", async () => {
      const setup = pairedHost();
      setup.relay.answerPings = false;
      const { waiting } = setup.start();
      await vi.advanceTimersByTimeAsync(60_000);

      setup.host.close();
      await expect(waiting).rejects.toThrow(/has been closed/);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("user rejection", () => {
    const REJECTED_MESSAGE = "This enrollment request has already been rejected.";
    const TOO_LATE_MESSAGE =
      "This enrollment request can no longer be rejected once its completion delivery has started.";
    const REFUSED_MESSAGE =
      "The enrollment host already received a completion for this request; it can no longer be rejected.";

    it("rejects after connect(), resolves on the acknowledgement and fails the host as rejected", async () => {
      const setup = waitingHost();
      const candidate = setup.candidate();
      await candidate.connect();

      await expect(candidate.reject()).resolves.toBeUndefined();
      const error: unknown = await setup.waiting.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AgentEnrollmentRejectedError);
      expect(error).toBeInstanceOf(AgentIntentSdkError);
      expect(error).toMatchObject({
        name: "AgentEnrollmentRejectedError",
        kind: "enrollment",
        message: "The user rejected this agent enrollment request.",
      });
      expect(isAgentEnrollmentRejectedError(error)).toBe(true);
      expect(setup.authenticate).not.toHaveBeenCalled();
      expect(setup.persist).not.toHaveBeenCalled();
      expect(setup.relay.sockets).toHaveLength(2);
      expect(setup.relay.sockets.every((socket) => socket.closed)).toBe(true);
      expect(() => candidate.connect()).toThrow(REJECTED_MESSAGE);
      expect(() => candidate.deliver(completionFor(setup.agent.publicKey, "late"))).toThrow(
        REJECTED_MESSAGE,
      );
      expect(() => candidate.reject()).toThrow(REJECTED_MESSAGE);
    });

    it("connects first when no session is open", async () => {
      const setup = waitingHost();
      const candidate = setup.candidate();

      const rejecting = candidate.reject();
      expect(setup.relay.sockets).toHaveLength(2);
      await expect(rejecting).resolves.toBeUndefined();
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
    });

    it("rejects a recovery request the same way", async () => {
      const setup = waitingHost(recoveryChannelRequest);

      await expect(setup.candidate().reject()).resolves.toBeUndefined();
      await expect(setup.waiting).rejects.toMatchObject({
        name: "AgentEnrollmentRejectedError",
        kind: "recovery",
        message: "The user rejected this agent recovery request.",
      });
      expect(setup.persist).not.toHaveBeenCalled();
    });

    it("ends the host for good, even when the relay closes it afterwards", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      const candidate = setup.candidate();
      await candidate.connect();

      await expect(candidate.reject()).resolves.toBeUndefined();
      await expect(waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
      const pings = setup.relay.pings;
      // The relay closes the remaining side about a second later; late events reach the old socket too.
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      setup.relay.hostSockets[0]?.emit("error");
      setup.relay.hostSockets[0]?.emit("close");
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(setup.relay.sockets.every((socket) => socket.closed)).toBe(true);
      expect(setup.relay.pings).toBe(pings);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ends the host for good on a rejection that arrives while a ping is unanswered", async () => {
      const setup = pairedHost();
      setup.relay.answerPings = false;
      const { waiting } = setup.start();
      const candidate = setup.candidate();
      await candidate.connect();

      // The host's first ping goes out at 60 s and would count as a drop 10 s later.
      await vi.advanceTimersByTimeAsync(65_000);
      await expect(candidate.reject()).resolves.toBeUndefined();
      await expect(waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(setup.relay.hostSockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      {
        timer: "acknowledgement",
        timeouts: { acknowledgementTimeoutMs: 1_000, completionTimeoutMs: 60_000 },
        message: "Enrollment rejection acknowledgement timed out.",
      },
      {
        timer: "session",
        timeouts: { acknowledgementTimeoutMs: 60_000, completionTimeoutMs: 1_000 },
        message: "Enrollment rejection timed out.",
      },
    ])("fails on the $timer timeout when the acknowledgement is lost", async (row) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
      const setup = waitingHost(channelRequest, withoutAcknowledgements);
      const candidate = setup.candidate({ timeouts: { ...reconnectTimeouts(), ...row.timeouts } });
      await candidate.connect();

      const rejecting = expect(candidate.reject()).rejects.toThrow(row.message);
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
      await vi.advanceTimersByTimeAsync(999);
      expect(setup.relay.sockets[1]?.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejecting;
      expect(setup.relay.sockets.every((socket) => socket.closed)).toBe(true);
    });

    it.each([
      {
        cause: "the session deadline",
        close: false,
        connectMessage: "Enrollment completion delivery timed out.",
        rejectMessage: "Enrollment rejection timed out.",
      },
      {
        cause: "a relay close",
        close: true,
        connectMessage: "Enrollment relay closed before completion was acknowledged.",
        rejectMessage: "Enrollment relay closed before the rejection was sent.",
      },
    ])(
      "reports $cause before the handshake to reject() alone as a rejection failure",
      async (row) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
        // No host listens on this relay, so the handshake never completes.
        const relay = new TestRelay();
        if (row.close) relay.onSend = (sender) => sender.close();
        const request = channelRequest(createSoftwareAgentIdentity(), {
          environment: "production",
          hostPublicKey: createSoftwareAgentIdentity().publicKey,
        });
        const candidate = createAgentEnrollmentChannelCandidate({
          request,
          relayBaseUrl: RELAY_URL,
          webSocketFactory: relay.factory,
          timeouts: { ...reconnectTimeouts(), completionTimeoutMs: 1_000 },
        });

        // Both share one session; only the rejection's own promise names the rejection.
        const connecting = expect(candidate.connect()).rejects.toThrow(row.connectMessage);
        const rejecting = expect(candidate.reject()).rejects.toThrow(row.rejectMessage);
        await vi.advanceTimersByTimeAsync(1_000);
        await connecting;
        await rejecting;
        expect(relay.sockets).toHaveLength(1);
      },
    );

    it.each([0, 5])(
      "ends the host on a rejection queued when the relay dropped it after %i reconnects",
      async (reconnects) => {
        const setup = pairedHost();
        const { waiting } = setup.start();
        // Each quick drop moves the host further into its reopening backoff.
        for (let round = 0; round < reconnects; round += 1) {
          await setup.leave();
          await vi.advanceTimersByTimeAsync(5_000);
        }
        const candidate = setup.candidate();
        await candidate.connect();

        setup.relay.dropRecipientAfter = "TrustchainShareCredential";
        const rejecting = expect(candidate.reject()).rejects.toThrow(
          "Enrollment relay closed before the rejection was acknowledged.",
        );
        await expect(waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
        await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
        await rejecting;
        setup.relay.dropRecipientAfter = undefined;

        // The host honored it, though reject() failed: a retry finds no host any more, and no
        // reopen is pending.
        await expect(candidate.reject()).rejects.toThrow(
          "The enrollment relay rejected the session.",
        );
        await vi.advanceTimersByTimeAsync(60_000);
        expect(setup.relay.hostSockets).toHaveLength(reconnects + 1);
      },
    );

    it("retries a rejection on a fresh session after the relay refused the first one", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      const first = setup.candidate();
      await first.connect();
      first.close();

      // The relay has not closed the host yet, so this candidate finds the channel without one.
      const second = setup.candidate();
      await expect(second.reject()).rejects.toThrow("The enrollment relay rejected the session.");
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);

      await expect(second.reject()).resolves.toBeUndefined();
      await expect(waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
    });

    it("refuses a rejection from a fresh candidate once the host received a completion", async () => {
      const setup = waitingHost();
      setup.authenticate.mockRejectedValueOnce(new Error("Keycloak unavailable"));
      const payload = completionFor(setup.agent.publicKey, "trusted");
      await expect(setup.candidate().deliver(payload)).rejects.toThrow(/host rejected/);

      // Like a page reload after the device committed: this candidate never delivered.
      const reloaded = setup.candidate();
      await expect(reloaded.reject()).rejects.toThrow(REFUSED_MESSAGE);
      // Final, so retries do not cost the host its reconnects.
      expect(() => reloaded.reject()).toThrow(REFUSED_MESSAGE);
      expect(setup.relay.sockets).toHaveLength(3);
      await expectHostStillWaiting(setup);
    });

    it("refuses a rejection once a completion arrived on a socket the relay dropped", async () => {
      const setup = pairedHost();
      const { isSettled } = setup.start();
      const first = setup.candidate();
      await first.connect();

      setup.relay.dropRecipientAfter = "TrustchainShareCredential";
      void first.deliver(completionFor(setup.agent.publicKey, "committed")).catch(() => undefined);
      await vi.waitFor(() => expect(setup.relay.hostSockets).toHaveLength(2));
      setup.relay.dropRecipientAfter = undefined;
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(setup.authenticate).not.toHaveBeenCalled();

      await expect(setup.candidate().reject()).rejects.toThrow(REFUSED_MESSAGE);
      expect(isSettled()).toBe(false);
    });

    it("still accepts a rejection after a malformed completion", async () => {
      const setup = waitingHost();
      const raw = await rawCandidate(setup.relay, setup.request);
      await raw.confirm();

      raw.socket.send(await raw.seal("TrustchainShareCredential", { completion: "malformed" }));
      expect(await raw.open(await raw.next())).toEqual({
        message: "Failure",
        payload: { reason: "reset" },
      });
      raw.socket.close();
      await expect(setup.candidate().reject()).resolves.toBeUndefined();
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
    });

    it("sends and accepts the documented wire payloads", async () => {
      const setup = waitingHost();
      const raw = await rawCandidate(setup.relay, setup.request);
      await raw.confirm();

      raw.socket.send(await raw.seal("TrustchainShareCredential", { reason: "user-rejected" }));
      expect(await raw.open(await raw.next())).toEqual({
        message: "TrustchainAddedMember",
        payload: { reason: "rejection-acknowledged" },
      });
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
    });

    it("sends only frames the Trustchain relay accepts", async () => {
      const hostFrames: RelayFrame[] = [];
      const candidateFrames: RelayFrame[] = [];
      const candidate = (setup: ReturnType<typeof waitingHost>) =>
        setup.candidate({
          webSocketFactory: recordingFrames(candidateFrames)(setup.relay.factory),
        });
      const refusing = waitingHost(channelRequest, recordingFrames(hostFrames));
      refusing.authenticate.mockRejectedValueOnce(new Error("denied"));
      const payload = completionFor(refusing.agent.publicKey, "trusted");

      await expect(candidate(refusing).deliver(payload)).rejects.toThrow(
        "The enrollment host rejected this completion.",
      );
      await expect(candidate(refusing).reject()).rejects.toThrow(REFUSED_MESSAGE);
      await expect(candidate(refusing).deliver(payload)).resolves.toBeUndefined();
      const accepting = waitingHost(channelRequest, recordingFrames(hostFrames));
      await expect(candidate(accepting).reject()).resolves.toBeUndefined();

      // A refused delivery, a refused rejection, a delivery, and an accepted rejection.
      const handshake = ["InitiateHandshake", "CompleteHandshakeChallenge"];
      expect(candidateFrames.map((frame) => frame.message)).toEqual(
        Array.from({ length: 4 }, () => [...handshake, "TrustchainShareCredential"]).flat(),
      );
      const challenge = ["HandshakeChallenge", "HandshakeCompletionSucceeded"];
      expect(hostFrames.map((frame) => frame.message)).toEqual(
        ["Failure", "Failure", "TrustchainAddedMember", "TrustchainAddedMember"].flatMap(
          (answer) => [...challenge, answer],
        ),
      );
      for (const frame of [...candidateFrames, ...hostFrames]) {
        if (frame.message !== "InitiateHandshake") expectRelayPayload(frame);
      }
    });

    it.each([
      {
        name: "acknowledges",
        message: "TrustchainAddedMember" as const,
        reply: { reason: "rejection-acknowledged" },
        error: undefined,
      },
      {
        name: "already received a completion",
        message: "Failure" as const,
        reply: { reason: "completion-received" },
        error: REFUSED_MESSAGE,
      },
      {
        name: "resets the candidate",
        message: "Failure" as const,
        reply: { reason: "reset" },
        error: "The enrollment host reset this session.",
      },
      {
        name: "refuses with a body that is not exactly the refusal",
        message: "Failure" as const,
        reply: { reason: "completion-received", acknowledged: true },
        error: "The enrollment host reset this session.",
      },
      {
        name: "acknowledges a delivery instead",
        message: "TrustchainAddedMember" as const,
        reply: { acknowledged: true, digest: "00" },
        error: "Enrollment rejection acknowledgement is invalid.",
      },
      {
        name: "acknowledges with a body that is not exactly the rejection's",
        message: "TrustchainAddedMember" as const,
        reply: { reason: "rejection-acknowledged", acknowledged: true },
        error: "Enrollment rejection acknowledgement is invalid.",
      },
      {
        name: "sends the acknowledgement as a Failure",
        message: "Failure" as const,
        reply: { reason: "rejection-acknowledged" },
        error: "The enrollment host reset this session.",
      },
    ])("settles the candidate when the host $name", async ({ message, reply, error }) => {
      const host = await rawHost();
      const rejecting = host.candidate().reject();
      const outcome = error
        ? expect(rejecting).rejects.toThrow(error)
        : expect(rejecting).resolves.toBeUndefined();

      const peer = await host.confirm();
      expect(await peer.open(await host.next())).toEqual({
        message: "TrustchainShareCredential",
        payload: { reason: "user-rejected" },
      });
      host.socket.send(await peer.seal(message, reply));
      await outcome;
    });

    it.each([
      { name: "a rejection's acknowledgement", withDigest: false },
      { name: "an acknowledgement that also carries a reason", withDigest: true },
    ])("does not take $name for a delivery's", async ({ withDigest }) => {
      const host = await rawHost();
      const payload = completionFor(host.request.publicKey, "sent");
      const delivering = host.candidate().deliver(payload);
      const outcome = expect(delivering).rejects.toThrow(
        "Enrollment completion acknowledgement is invalid.",
      );

      const peer = await host.confirm();
      expect((await peer.open(await host.next())).message).toBe("TrustchainShareCredential");
      const digest = createHash("sha256").update(payload).digest("hex");
      host.socket.send(
        await peer.seal("TrustchainAddedMember", {
          reason: "rejection-acknowledged",
          ...(withDigest && { acknowledged: true, digest }),
        }),
      );
      await outcome;
    });

    it("lets connect() wait on a running delivery whose socket the relay dropped", async () => {
      const setup = waitingHost(channelRequest, withoutAcknowledgements);
      const candidate = setup.candidate();
      const delivering = candidate.deliver(completionFor(setup.agent.publicKey, "pending"));
      await vi.waitFor(() => expect(setup.persist).toHaveBeenCalledOnce());

      // The loss is reported behind the frames already read, but the session is already spent.
      setup.relay.sockets[1]?.drop();
      await expect(candidate.connect()).resolves.toBeUndefined();
      await expect(delivering).rejects.toThrow(
        "Enrollment relay closed before completion was acknowledged.",
      );
      expect(setup.relay.sockets).toHaveLength(2);
    });

    it.each([
      {
        name: "the relay's own Failure",
        frame: async () => JSON.stringify(relayFailure("PEER_INVALID_MESSAGE")),
      },
      {
        name: "a refusal published by the relay's key",
        frame: async (peer: ChannelPeer) =>
          editFrame(await peer.seal("Failure", { reason: "completion-received" }), (frame) => {
            frame.publisher = "00".repeat(33);
          }),
      },
      {
        name: "a host Failure of another type",
        frame: async (peer: ChannelPeer) =>
          editFrame(await peer.seal("Failure", { reason: "completion-received" }), (frame) => {
            frame.payload.type = "PEER_INVALID_MESSAGE";
          }),
      },
      {
        name: "a host refusal that does not decrypt",
        frame: async (peer: ChannelPeer) =>
          tamperedFrame(await peer.seal("Failure", { reason: "completion-received" })),
      },
      {
        name: "an encrypted Failure of an older host",
        frame: async (peer: ChannelPeer) =>
          editFrame(await peer.seal("Failure", { reason: "completion-received" }), (frame) => {
            frame.payload = { encrypted: frame.payload.message };
          }),
      },
    ])("reports $name to reject() as a relay failure", async ({ frame }) => {
      const host = await rawHost();
      const candidate = host.candidate();
      const rejecting = expect(candidate.reject()).rejects.toThrow(
        "The enrollment relay rejected the session.",
      );

      const peer = await host.confirm();
      expect((await peer.open(await host.next())).message).toBe("TrustchainShareCredential");
      host.socket.send(await frame(peer));
      await rejecting;
      // Unlike the host's refusal, it is not final.
      const retry = candidate.reject();
      candidate.close();
      await expect(retry).rejects.toThrow("This enrollment completion channel has been closed.");
    });

    it("reads the host's refusal before the relay closes the candidate right after it", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      setup.authenticate.mockRejectedValueOnce(new Error("denied"));
      // Like the Trustchain relay, which closes both sides once it forwarded a Failure.
      setup.relay.dropRecipientAfter = "Failure";
      const delivering = setup.candidate();
      await expect(
        delivering.deliver(completionFor(setup.agent.publicKey, "denied")),
      ).rejects.toThrow("The enrollment host rejected this completion.");
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);

      const rejecting = setup.candidate();
      await expect(rejecting.reject()).rejects.toThrow(REFUSED_MESSAGE);
      expect(() => rejecting.reject()).toThrow(REFUSED_MESSAGE);
      // The relay closed the host too, and a second reopen in a row waits a second.
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs + 1_000);

      setup.relay.dropRecipientAfter = undefined;
      await expect(
        delivering.deliver(completionFor(setup.agent.publicKey, "retried")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "retried" });
    });

    it("keeps the host waiting after a tampered rejection", async () => {
      const setup = waitingHost();
      const tampering = setup.candidate({
        webSocketFactory: (url) => {
          const socket = setup.relay.factory(url);
          const send = socket.send.bind(socket);
          socket.send = (data) =>
            send(data.includes('"TrustchainShareCredential"') ? tamperedFrame(data) : data);
          return socket;
        },
      });

      await expect(tampering.reject()).rejects.toThrow("The enrollment host reset this session.");
      await expectHostStillWaiting(setup);
    });

    it("keeps the host waiting after a rejection sealed by another key", async () => {
      const setup = waitingHost();
      const candidate = setup.candidate();
      await candidate.connect();

      const intruder = channelPeer(
        setup.request,
        createSoftwareAgentIdentity(),
        setup.request.channel.hostPublicKey,
      );
      setup.relay.sockets[0]?.emit("message", {
        data: await intruder.seal("TrustchainShareCredential", { reason: "user-rejected" }),
      });
      // Like any frame that is not its peer's, it resets the confirmed candidate.
      await vi.waitFor(() => expect(setup.relay.sockets[1]?.closed).toBe(true));
      expect(setup.hostFailure).not.toHaveBeenCalled();

      await expect(candidate.reject()).resolves.toBeUndefined();
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
    });

    it("reports a host reset that crosses the rejection as retryable", async () => {
      const setup = waitingHost();
      const candidate = setup.candidate();
      await candidate.connect();

      // A stray frame makes the host reset the confirmed candidate as the user rejects.
      const intruder = channelPeer(
        setup.request,
        createSoftwareAgentIdentity(),
        setup.request.channel.hostPublicKey,
      );
      setup.relay.sockets[0]?.emit("message", {
        data: await intruder.seal("TrustchainShareCredential", { reason: "user-rejected" }),
      });
      await expect(candidate.reject()).rejects.toThrow("The enrollment host reset this session.");
      expect(setup.hostFailure).not.toHaveBeenCalled();

      await expect(candidate.reject()).resolves.toBeUndefined();
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
    });

    it("keeps the host waiting after a rejection before key confirmation", async () => {
      const setup = waitingHost();
      const stranger = channelPeer(
        setup.request,
        createSoftwareAgentIdentity(),
        setup.request.channel.hostPublicKey,
      );
      // Before any handshake.
      setup.relay.sockets[0]?.emit("message", {
        data: await stranger.seal("TrustchainShareCredential", { reason: "user-rejected" }),
      });

      // Challenged, but the challenge was never answered.
      const raw = await rawCandidate(setup.relay, setup.request);
      raw.socket.send(await raw.seal("TrustchainShareCredential", { reason: "user-rejected" }));
      expect(await raw.open(await raw.next())).toEqual({
        message: "Failure",
        payload: { reason: "reset" },
      });
      raw.socket.close();
      await expectHostStillWaiting(setup);
    });

    it.each([
      {
        name: "a rejection body with another reason",
        message: "TrustchainShareCredential" as const,
        payload: () => ({ reason: "reset" }),
      },
      {
        name: "a rejection body that also carries a completion",
        message: "TrustchainShareCredential" as const,
        payload: (agent: string) => ({
          reason: "user-rejected",
          completion: completionFor(agent, "ambiguous"),
        }),
      },
      {
        name: "a rejection sent as a Failure",
        message: "Failure" as const,
        payload: () => ({ reason: "user-rejected" }),
      },
    ])("keeps the host waiting after $name from its confirmed candidate", async (row) => {
      const setup = waitingHost();
      const raw = await rawCandidate(setup.relay, setup.request);
      await raw.confirm();

      raw.socket.send(await raw.seal(row.message, row.payload(setup.agent.publicKey)));
      expect(await raw.open(await raw.next())).toEqual({
        message: "Failure",
        payload: { reason: "reset" },
      });
      raw.socket.close();
      expect(setup.authenticate).not.toHaveBeenCalled();
      await expectHostStillWaiting(setup);
    });

    it.each(["PROTOCOL_VIOLATION", "PEER_INVALID_MESSAGE"])(
      "keeps the host waiting after the relay's own %s Failure, as before",
      async (type) => {
        const setup = waitingHost();
        const candidate = setup.candidate();
        await candidate.connect();

        setup.relay.sockets[0]?.emit("message", { data: JSON.stringify(relayFailure(type)) });
        await vi.waitFor(() => expect(setup.relay.sockets[1]?.closed).toBe(true));
        expect(setup.hostFailure).not.toHaveBeenCalled();
        await expect(
          candidate.deliver(completionFor(setup.agent.publicKey, "after-relay-failure")),
        ).resolves.toBeUndefined();
        await expect(setup.waiting).resolves.toMatchObject({
          trustchainId: "after-relay-failure",
        });
      },
    );

    it.each([
      { name: "is authenticated", authenticated: true },
      { name: "fails authentication", authenticated: false },
    ])(
      "does not let a queued rejection abort a completion that $name",
      async ({ authenticated }) => {
        const setup = waitingHost();
        let settleAuthentication: () => void = () => undefined;
        setup.authenticate.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve, reject) => {
              settleAuthentication = authenticated
                ? () => resolve(undefined)
                : () => reject(new Error("denied"));
            }),
        );
        const raw = await rawCandidate(setup.relay, setup.request);
        await raw.confirm();

        raw.socket.send(
          await raw.seal("TrustchainShareCredential", {
            completion: completionFor(setup.agent.publicKey, "in-flight"),
          }),
        );
        raw.socket.send(await raw.seal("TrustchainShareCredential", { reason: "user-rejected" }));
        await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce());
        settleAuthentication();

        if (authenticated) {
          await expect(setup.waiting).resolves.toMatchObject({ trustchainId: "in-flight" });
          expect(setup.persist).toHaveBeenCalledOnce();
          expect(await raw.open(await raw.next())).toMatchObject({
            message: "TrustchainAddedMember",
            payload: { acknowledged: true },
          });
        } else {
          expect(await raw.open(await raw.next())).toEqual({
            message: "Failure",
            payload: { reason: "reset" },
          });
          raw.socket.close();
          await expectHostStillWaiting(setup);
        }
      },
    );

    it("refuses to reject once a delivery started, even after it failed", async () => {
      const setup = waitingHost();
      setup.authenticate.mockRejectedValueOnce(new Error("denied"));
      const candidate = setup.candidate();
      const payload = completionFor(setup.agent.publicKey, "trusted");

      const delivering = candidate.deliver(payload);
      expect(() => candidate.reject()).toThrow(TOO_LATE_MESSAGE);
      await expect(delivering).rejects.toThrow(/host rejected/);
      expect(() => candidate.reject()).toThrow(TOO_LATE_MESSAGE);
      await expect(candidate.deliver(payload)).resolves.toBeUndefined();
      expect(() => candidate.reject()).toThrow(TOO_LATE_MESSAGE);
      await expect(setup.waiting).resolves.toMatchObject({ trustchainId: "trusted" });
    });

    it("refuses a delivery or a second rejection while a rejection is pending", async () => {
      const setup = waitingHost();
      const candidate = setup.candidate();

      const rejecting = candidate.reject();
      expect(() => candidate.reject()).toThrow(
        "This enrollment request is already being rejected.",
      );
      expect(() => candidate.deliver(completionFor(setup.agent.publicKey, "late"))).toThrow(
        "This enrollment request is being rejected.",
      );
      await expect(rejecting).resolves.toBeUndefined();
    });

    it("refuses to reject a closed or expired candidate", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2098-01-01T00:00:00.000Z"));
      const relay = new TestRelay();
      const request = channelRequest(createSoftwareAgentIdentity(), {
        environment: "production",
        hostPublicKey: createSoftwareAgentIdentity().publicKey,
      });
      const candidate = () =>
        createAgentEnrollmentChannelCandidate({
          request,
          relayBaseUrl: RELAY_URL,
          webSocketFactory: relay.factory,
        });
      const closed = candidate();
      closed.close();
      expect(() => closed.reject()).toThrow("This enrollment completion channel has been closed.");

      const expired = candidate();
      vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
      expect(() => expired.reject()).toThrow("The enrollment channel has expired.");
      expect(relay.sockets).toHaveLength(0);
    });

    it("closes the candidate when it is closed during a rejection", async () => {
      const setup = waitingHost(channelRequest, withoutAcknowledgements);
      const candidate = setup.candidate();
      await candidate.connect();

      const rejecting = candidate.reject();
      await expect(setup.waiting).rejects.toSatisfy(isAgentEnrollmentRejectedError);
      candidate.close();
      await expect(rejecting).rejects.toThrow(
        "This enrollment completion channel has been closed.",
      );
      expect(setup.relay.sockets.every((socket) => socket.closed)).toBe(true);
    });

    it("recognizes a rejection error by shape, including from another realm", () => {
      expect(isAgentEnrollmentRejectedError(new AgentEnrollmentRejectedError("recovery"))).toBe(
        true,
      );
      const foreign: unknown = runInNewContext(
        'Object.assign(new Error("rejected"), { name: "AgentEnrollmentRejectedError", kind: "enrollment" })',
      );
      expect(foreign).not.toBeInstanceOf(Error);
      expect(isAgentEnrollmentRejectedError(foreign)).toBe(true);
      for (const value of [
        new AgentIntentSdkError("The user rejected this agent enrollment request."),
        Object.assign(new Error("rejected"), { name: "AgentEnrollmentRejectedError" }),
        Object.assign(new Error("rejected"), { name: "AgentEnrollmentRejectedError", kind: "x" }),
        // Not an Error, even though it has the fields.
        { name: "AgentEnrollmentRejectedError", kind: "enrollment", message: "rejected" },
        "AgentEnrollmentRejectedError",
        null,
        undefined,
      ]) {
        expect(isAgentEnrollmentRejectedError(value)).toBe(false);
      }
    });

    it("exports the rejection error and its guard from the package root", () => {
      expect(packageExports.AgentEnrollmentRejectedError).toBe(AgentEnrollmentRejectedError);
      expect(packageExports.isAgentEnrollmentRejectedError).toBe(isAgentEnrollmentRejectedError);
    });
  });
});

/** A host waiting on a plain test relay with real timers; `hostFailure` records its rejection. */
function waitingHost(
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
async function expectHostStillWaiting(setup: ReturnType<typeof waitingHost>): Promise<void> {
  expect(setup.hostFailure).not.toHaveBeenCalled();
  await expect(
    setup.candidate().deliver(completionFor(setup.agent.publicKey, "still-waiting")),
  ).resolves.toBeUndefined();
  await expect(setup.waiting).resolves.toMatchObject({ trustchainId: "still-waiting" });
}

/** Drops every acknowledgement the wrapped sockets send. */
function withoutAcknowledgements(
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
function recordingFrames(frames: RelayFrame[]) {
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
function expectRelayPayload(frame: RelayFrame): void {
  expect(frame.payload).toStrictEqual(
    frame.message === "Failure"
      ? { type: "UNEXPECTED_SHARE_CREDENTIAL", message: expect.any(String) }
      : { encrypted: expect.any(String) },
  );
}

function ciphertextField(frame: RelayFrame): "message" | "encrypted" {
  return frame.message === "Failure" ? "message" : "encrypted";
}

/** Flips one bit of an encrypted envelope's ciphertext. */
function tamperedFrame(frame: string): string {
  return editFrame(frame, (envelope) => {
    const field = ciphertextField(envelope);
    const blob = Buffer.from(String(envelope.payload[field]), "base64");
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 1, blob.length - 1);
    envelope.payload[field] = blob.toString("base64");
  });
}

function editFrame(frame: string, edit: (envelope: RelayFrame) => void): string {
  const envelope = JSON.parse(frame) as RelayFrame;
  edit(envelope);
  return JSON.stringify(envelope);
}

type ChannelMessage = Parameters<typeof enrollmentChannelCryptoVectors.encrypt>[2]["message"];

type RelayFrame = {
  version: number;
  publisher: string;
  message: ChannelMessage;
  payload: Record<string, unknown>;
};

type ChannelPeer = ReturnType<typeof channelPeer>;

/** Seals and opens channel envelopes with a key the test holds, to speak the protocol by hand. */
function channelPeer(
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
function rawSocket(relay: TestRelay) {
  const socket = relay.factory(`${RELAY_URL}/v1/qr`);
  const frames: string[] = [];
  let read = 0;
  const opened = new Promise<void>((resolve) => socket.addEventListener("open", resolve));
  socket.addEventListener("message", (event) => frames.push(String(event.data)));
  return {
    socket,
    opened,
    next: async (): Promise<string> => {
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(read));
      return frames[read++]!;
    },
  };
}

/** A host whose key the test holds on a plain relay, facing a candidate the SDK runs. */
async function rawHost() {
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
async function rawCandidate(relay: TestRelay, request: AgentEnrollmentChannelRequest) {
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

function reconnectTimeouts() {
  return {
    candidateTimeoutMs: 30 * 60_000,
    handshakeTimeoutMs: 30 * 60_000,
    completionTimeoutMs: 30 * 60_000,
    acknowledgementTimeoutMs: 30 * 60_000,
    persistTimeoutMs: 30 * 60_000,
  };
}

/** A host on a relay that behaves like the Trustchain one, with fake timers. */
function pairedHost(
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
async function expectNextSocketAfter(
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
async function silentCandidate(setup: ReturnType<typeof pairedHost>): Promise<TestSocket> {
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

function relayFailure(type = "PROTOCOL_VIOLATION") {
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

class TestRelay {
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
