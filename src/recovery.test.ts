import { describe, expect, it } from "vitest";
import { createSoftwareAgentIdentity } from "./identity.ts";
import {
  agentRecoverySearch,
  canonicalAgentRecoveryPayload,
  createAgentRecoveryRequest,
  createAgentRecoveryUrl,
  parseAgentRecoveryCompletion,
  serializeAgentRecoveryCompletion,
  validateAgentRecovery,
} from "./recovery.ts";

const identity = createSoftwareAgentIdentity("00".repeat(31) + "03");
const hostPublicKey = createSoftwareAgentIdentity("00".repeat(31) + "02").publicKey;
const input = {
  name: "Existing Agent",
  description: "Existing metadata",
  source: "hermes",
  previousTrustchainId: "closed-app18-root",
  expiresAt: "2030-01-01T00:00:00.000Z",
} as const;
const NOW = new Date("2029-01-01T00:00:00.000Z");

describe("agent recovery protocol", () => {
  it("authenticates the recovery mode, existing identity metadata, and previous Trustchain", () => {
    const request = createAgentRecoveryRequest(identity, input);

    expect(validateAgentRecovery(agentRecoverySearch(request), NOW)).toEqual({
      status: "valid",
      request,
    });
    expect(
      validateAgentRecovery(
        { ...agentRecoverySearch(request), previousTrustchainId: "other-root" },
        NOW,
      ),
    ).toMatchObject({ status: "invalid", reason: "invalid-signature" });
    expect(
      validateAgentRecovery(agentRecoverySearch(request), new Date("2031-01-01")),
    ).toMatchObject({ status: "invalid", reason: "expired" });
    expect(
      validateAgentRecovery({ ...agentRecoverySearch(request), extra: "1" }, NOW),
    ).toMatchObject({ status: "invalid", reason: "malformed" });
    expect(() => createAgentRecoveryRequest(identity, { ...input, source: "codex" })).toThrow(
      /not supported/,
    );
  });

  it("matches the fixed unbound recovery vector", () => {
    const request = createAgentRecoveryRequest(identity, input);

    expect(new TextDecoder().decode(canonicalAgentRecoveryPayload(request))).toMatchInlineSnapshot(`
      "agent-intent:agent-recovery:v2
      {"v":"3","recovery":true,"publicKey":"02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9","name":"Existing Agent","description":"Existing metadata","source":"hermes","previousTrustchainId":"closed-app18-root","expiresAt":"2030-01-01T00:00:00.000Z"}"
    `);
    expect(request.signature).toMatchInlineSnapshot(
      `"ef79cc24335556084abbaf2b9df1ee498db45b9c0c7c08fc3de2dcf65c2d58a03f7f47218eed1c2b5ba64704ae01fd125951630a809d4ae26037ea82c4316fb4"`,
    );
    expect(createAgentRecoveryUrl("https://agents.example", request)).toMatchInlineSnapshot(
      `"https://agents.example/agents/new?v=3&recovery=true&publicKey=02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9&name=Existing+Agent&description=Existing+metadata&source=hermes&previousTrustchainId=closed-app18-root&expiresAt=2030-01-01T00%3A00%3A00.000Z&signature=ef79cc24335556084abbaf2b9df1ee498db45b9c0c7c08fc3de2dcf65c2d58a03f7f47218eed1c2b5ba64704ae01fd125951630a809d4ae26037ea82c4316fb4"`,
    );
  });

  it("signs an optional channel binding", () => {
    const request = createAgentRecoveryRequest(identity, {
      ...input,
      channel: { environment: "production", hostPublicKey: hostPublicKey.toUpperCase() },
    });

    expect(request.channel).toEqual({ environment: "production", hostPublicKey });
    expect(new TextDecoder().decode(canonicalAgentRecoveryPayload(request))).toMatchInlineSnapshot(`
      "agent-intent:agent-recovery:v2
      {"v":"3","recovery":true,"publicKey":"02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9","name":"Existing Agent","description":"Existing metadata","source":"hermes","previousTrustchainId":"closed-app18-root","expiresAt":"2030-01-01T00:00:00.000Z","channelEnvironment":"production","channelHost":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"}"
    `);
    expect(request.signature).toMatchInlineSnapshot(
      `"1e08a4c888581291864ece8d7ae74b81a031787e00efdfb48ba7c574b3249f2e2a9519c78fd982865bd817acb0e79d206b60fafc311a50418b77d1ab0ff1f563"`,
    );
    expect(validateAgentRecovery(agentRecoverySearch(request), NOW)).toEqual({
      status: "valid",
      request,
    });
    const otherHost = createSoftwareAgentIdentity().publicKey;
    expect(
      validateAgentRecovery({ ...agentRecoverySearch(request), channelHost: otherHost }, NOW),
    ).toMatchObject({ status: "invalid", reason: "invalid-signature" });
    expect(
      validateAgentRecovery(
        { ...agentRecoverySearch(request), channelEnvironment: "staging" },
        NOW,
      ),
    ).toMatchObject({ status: "invalid", reason: "invalid-signature" });
    const { channelEnvironment: _, ...partial } = agentRecoverySearch(request);
    expect(validateAgentRecovery(partial, NOW)).toMatchObject({
      status: "invalid",
      reason: "malformed",
    });
    expect(
      validateAgentRecovery(
        { ...agentRecoverySearch(request), channelHost: `02${"ff".repeat(32)}` },
        NOW,
      ),
    ).toMatchObject({ status: "invalid", reason: "malformed" });
  });

  it("binds completion to the same public key, previous Trustchain, and request", () => {
    const payload = serializeAgentRecoveryCompletion({
      agentPubkey: identity.publicKey,
      previousTrustchainId: "closed-app18-root",
      requestSignature: "ab".repeat(64),
      trustchainId: "closed-app18-root",
    });

    expect(
      parseAgentRecoveryCompletion(
        payload,
        identity.publicKey,
        "closed-app18-root",
        "AB".repeat(64),
      ),
    ).toEqual({
      version: 3,
      recovery: true,
      agentPubkey: identity.publicKey,
      previousTrustchainId: "closed-app18-root",
      requestSignature: "ab".repeat(64),
      trustchainId: "closed-app18-root",
    });
    expect(() =>
      parseAgentRecoveryCompletion(payload, identity.publicKey, "other-root", "ab".repeat(64)),
    ).toThrow("does not match the profile's previous Trustchain");
    expect(() =>
      parseAgentRecoveryCompletion(
        payload,
        identity.publicKey,
        "closed-app18-root",
        "cd".repeat(64),
      ),
    ).toThrow("does not match the pending signed recovery request");
    expect(() =>
      parseAgentRecoveryCompletion(payload, hostPublicKey, "closed-app18-root", "ab".repeat(64)),
    ).toThrow("does not match the existing agent identity");
    const unrelatedResult = serializeAgentRecoveryCompletion({
      agentPubkey: identity.publicKey,
      previousTrustchainId: "closed-app18-root",
      requestSignature: "ab".repeat(64),
      trustchainId: "other-root",
    });
    expect(() =>
      parseAgentRecoveryCompletion(
        unrelatedResult,
        identity.publicKey,
        "closed-app18-root",
        "ab".repeat(64),
      ),
    ).toThrow("returned an unrelated Trustchain");
    expect(() =>
      parseAgentRecoveryCompletion(
        JSON.stringify({ ...JSON.parse(payload), accountAccess: {} }),
        identity.publicKey,
        "closed-app18-root",
        "ab".repeat(64),
      ),
    ).toThrow("malformed");
  });
});
