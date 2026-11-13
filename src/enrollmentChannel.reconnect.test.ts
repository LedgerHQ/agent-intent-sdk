import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconnectTimeouts,
  pairedHost,
  expectNextSocketAfter,
  silentCandidate,
  relayFailure,
  completionFor,
  TestSocket,
} from "./enrollmentChannel.test-support.ts";

describe("encrypted enrollment channel", () => {
  afterEach(() => vi.useRealTimers());

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
      await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce(), { interval: 1 });
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
        await vi.waitFor(() => expect(setup[phase]).toHaveBeenCalledOnce(), { interval: 1 });

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
      await vi.waitFor(() => expect(setup.relay.hostSockets).toHaveLength(2), { interval: 1 });
      setup.relay.dropRecipientAfter = undefined;
      expect(setup.authenticate).not.toHaveBeenCalled();
      expect(setup.persist).not.toHaveBeenCalled();
      expect(isSettled()).toBe(false);

      await expect(
        setup.candidate().deliver(completionFor(setup.agent.publicKey, "after-drop")),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ trustchainId: "after-drop" });
    });

    it("drops a completion whose socket the relay dropped while it was decrypted", async () => {
      const setup = pairedHost();
      const { isSettled } = setup.start();
      const first = setup.candidate();
      await first.connect();

      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce((...args) => {
        setup.relay.hostSockets[0]?.drop();
        return decrypt(...args);
      });
      void first.deliver(completionFor(setup.agent.publicKey, "dropped")).catch(() => undefined);
      await vi.waitFor(() => expect(setup.relay.hostSockets).toHaveLength(2), { interval: 1 });
      await vi.advanceTimersByTimeAsync(setup.relay.peerCloseDelayMs);
      expect(setup.authenticate).not.toHaveBeenCalled();
      expect(setup.persist).not.toHaveBeenCalled();

      await expect(setup.candidate().reject()).rejects.toThrow(/can no longer be rejected/);
      expect(isSettled()).toBe(false);
    });

    it("does not authenticate a completion once the host closed while it was decrypted", async () => {
      const setup = pairedHost();
      const { waiting } = setup.start();
      const candidate = setup.candidate();
      await candidate.connect();

      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      let decrypted: Promise<ArrayBuffer> | undefined;
      vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce((...args) => {
        setup.host.close();
        decrypted = decrypt(...args);
        return decrypted;
      });
      void candidate.deliver(completionFor(setup.agent.publicKey, "late")).catch(() => undefined);
      await expect(waiting).rejects.toThrow(/has been closed/);
      await decrypted;
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.authenticate).not.toHaveBeenCalled();
      expect(setup.persist).not.toHaveBeenCalled();
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
      await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce(), { interval: 1 });

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
      await vi.waitFor(() => expect(setup.authenticate).toHaveBeenCalledOnce(), { interval: 1 });
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
});
