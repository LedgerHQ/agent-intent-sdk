import { afterEach, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "./bytes.ts";
import {
  createAgentEnrollmentChannelCandidate,
  createAgentEnrollmentChannelHost,
  enrollmentChannelCryptoVectors,
} from "./enrollmentChannel.ts";
import {
  completionFor,
  RELAY_URL,
  RING_ACCESS_ENCRYPTION_KEY,
  ringAccessChannelRequest,
  TestRelay,
} from "./enrollmentChannel.test-support.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";
import { serializeAgentRecoveryCompletion } from "./recovery.ts";
import {
  serializeAgentRingAccessCompletion,
  type AgentRingAccessCompletion,
} from "./ringAccess.ts";

describe("encrypted enrollment channel", () => {
  afterEach(() => vi.useRealTimers());

  describe("ring access", () => {
    function ringAccessHost(environment: "staging" | "production" = "production") {
      const relay = new TestRelay();
      const agent = createSoftwareAgentIdentity();
      const host = createAgentEnrollmentChannelHost({
        environment,
        relayBaseUrl: RELAY_URL,
        webSocketFactory: relay.factory,
      });
      const request = ringAccessChannelRequest(agent, host.binding);
      const candidate = createAgentEnrollmentChannelCandidate({
        request,
        relayBaseUrl: RELAY_URL,
        webSocketFactory: relay.factory,
      });
      const grant = {
        agentPubkey: agent.publicKey,
        encryptionPublicKey: RING_ACCESS_ENCRYPTION_KEY,
        requestSignature: request.signature,
        environment,
        trustchainId: "app-18-root",
        applicationPath: "m/0'/17'/0'",
      } as const;
      return { agent, host, request, candidate, grant };
    }

    it("delivers a grant over a ring access request's channel", async () => {
      const { host, request, candidate, grant } = ringAccessHost("staging");
      const authenticate = vi.fn(async (_completion: AgentRingAccessCompletion) => undefined);
      const persist = vi.fn(async (_completion: AgentRingAccessCompletion) => undefined);
      const waiting = host.waitForCompletion({ request, authenticate, persist });

      await candidate.connect();
      await expect(
        candidate.deliver(serializeAgentRingAccessCompletion(grant)),
      ).resolves.toBeUndefined();
      await expect(waiting).resolves.toEqual({ version: 4, ...grant });
      expect(authenticate).toHaveBeenCalledExactlyOnceWith({ version: 4, ...grant });
      expect(persist).toHaveBeenCalledExactlyOnceWith({ version: 4, ...grant });
    });

    it("refuses a grant the agent cannot prove and keeps waiting for one it can", async () => {
      const { host, request, candidate, grant } = ringAccessHost();
      const authenticate = vi
        .fn<(completion: AgentRingAccessCompletion) => Promise<void>>()
        .mockRejectedValueOnce(new Error("not a member"))
        .mockResolvedValueOnce(undefined);
      const persist = vi.fn(async (_completion: AgentRingAccessCompletion) => undefined);
      const waiting = host.waitForCompletion({ request, authenticate, persist });
      const payload = serializeAgentRingAccessCompletion(grant);

      await expect(candidate.deliver(payload)).rejects.toThrow(/host rejected/);
      expect(persist).not.toHaveBeenCalled();
      await expect(candidate.deliver(payload)).resolves.toBeUndefined();
      await expect(waiting).resolves.toMatchObject({ applicationPath: grant.applicationPath });
      expect(authenticate).toHaveBeenCalledTimes(2);
      expect(persist).toHaveBeenCalledOnce();
    });

    it("refuses completions that do not match the ring access request", async () => {
      const { agent, host, request, candidate, grant } = ringAccessHost();
      const persist = vi.fn(async () => undefined);
      const waiting = host.waitForCompletion({
        request,
        authenticate: async () => undefined,
        persist,
      });
      const hostFailure = vi.fn();
      void waiting.catch(hostFailure);

      for (const completion of [
        completionFor(agent.publicKey, "app-18-root"),
        serializeAgentRecoveryCompletion({
          agentPubkey: agent.publicKey,
          previousTrustchainId: "app-18-root",
          requestSignature: request.signature,
          trustchainId: "app-18-root",
        }),
        serializeAgentRingAccessCompletion({
          ...grant,
          encryptionPublicKey: createSoftwareAgentIdentity().publicKey,
        }),
        serializeAgentRingAccessCompletion({ ...grant, requestSignature: "ab".repeat(64) }),
        serializeAgentRingAccessCompletion({ ...grant, trustchainId: "attacker-root" }),
      ]) {
        await expect(candidate.deliver(completion)).rejects.toThrow(/host rejected/);
      }
      expect(persist).not.toHaveBeenCalled();
      expect(hostFailure).not.toHaveBeenCalled();
      host.close();
    });

    it("binds channel keys to the signed ring access request", () => {
      const agent = createSoftwareAgentIdentity("00".repeat(31) + "01");
      const hostIdentity = createSoftwareAgentIdentity("00".repeat(31) + "02");
      const request = ringAccessChannelRequest(agent, {
        environment: "production",
        hostPublicKey: hostIdentity.publicKey,
      });
      const sharedSecret = agent.deriveSharedSecret(hexToBytes(hostIdentity.publicKey));

      expect(request.signature).toMatchInlineSnapshot(
        `"acb7b0b877dabe55d38c295dbddcb4379349bfa33a82c6347f7c2584b06ae03a2a8b5b52ce4053c6d3011236a009fceee699c4b8c05ed218834408d75ce70ae1"`,
      );
      expect(enrollmentChannelCryptoVectors.signedRequestDigest(request)).toMatchInlineSnapshot(
        `"4caea97e1927f2c6e65af85b9afaca3ff21731c4e878bb7b2811fa89c7f74d8b"`,
      );
      expect(enrollmentChannelCryptoVectors.deriveKey(sharedSecret, request)).toMatchInlineSnapshot(
        `"d2edc6dfbe71db5d58d93c0db0784ad4a95660c2a77288fbcbaa8b75ede01cb9"`,
      );
    });
  });
});
