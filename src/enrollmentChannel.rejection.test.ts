import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentIntentSdkError } from "./bytes.ts";
import {
  AgentEnrollmentRejectedError,
  createAgentEnrollmentChannelCandidate,
  isAgentEnrollmentRejectedError,
} from "./enrollmentChannel.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";
import * as packageExports from "./index.ts";
import {
  RELAY_URL,
  waitingHost,
  expectHostStillWaiting,
  withoutAcknowledgements,
  recordingFrames,
  expectRelayPayload,
  tamperedFrame,
  editFrame,
  type RelayFrame,
  type ChannelPeer,
  channelPeer,
  rawHost,
  rawCandidate,
  reconnectTimeouts,
  pairedHost,
  relayFailure,
  channelRequest,
  recoveryChannelRequest,
  completionFor,
  TestRelay,
} from "./enrollmentChannel.test-support.ts";

describe("encrypted enrollment channel", () => {
  afterEach(() => vi.useRealTimers());

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
      await vi.waitFor(() => expect(setup.relay.hostSockets).toHaveLength(2), { interval: 1 });
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
      await vi.waitFor(() => expect(setup.persist).toHaveBeenCalledOnce(), { interval: 1 });

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
      await vi.waitFor(() => expect(setup.relay.sockets[1]?.closed).toBe(true), { interval: 1 });
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
        await vi.waitFor(() => expect(setup.relay.sockets[1]?.closed).toBe(true), { interval: 1 });
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
        await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce(), { interval: 1 });
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
        {
          [Symbol.toStringTag]: "Error",
          name: "AgentEnrollmentRejectedError",
          kind: "enrollment",
          message: "rejected",
        },
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
