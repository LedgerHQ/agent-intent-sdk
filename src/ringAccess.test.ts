import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { bytesToHex } from "./bytes.ts";
import { SUPPORTED_AGENT_SOURCES } from "./enrollment.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";
import type { AgentEnrollmentChannelRequest } from "./enrollmentChannel.ts";
import {
  agentRecoverySearch,
  createAgentRecoveryRequest,
  isAgentRecoveryRequest,
} from "./recovery.ts";
import {
  agentRingAccessSearch,
  canonicalAgentRingAccessPayload,
  createAgentRingAccessRequest,
  createAgentRingAccessUrl,
  isAgentRingAccessRequest,
  isKeyRingApplicationPath,
  parseAgentRingAccessCompletion,
  serializeAgentRingAccessCompletion,
  validateAgentRingAccess,
  type AgentRingAccessCompletion,
} from "./ringAccess.ts";

const identity = createSoftwareAgentIdentity("00".repeat(31) + "03");
const encryptionPublicKey = createSoftwareAgentIdentity("00".repeat(31) + "04").publicKey;
const hostPublicKey = createSoftwareAgentIdentity("00".repeat(31) + "02").publicKey;
const input = {
  encryptionPublicKey,
  name: "Portfolio Bot",
  description: "Proposes portfolio operations.",
  source: "claude-code",
  trustchainId: "app18-root",
  expiresAt: "2099-01-01T00:00:00.000Z",
  channel: { environment: "production", hostPublicKey },
} as const;
const NOW = new Date("2029-01-01T00:00:00.000Z");

describe("agent ring access request", () => {
  it("matches the fixed ring access vector", () => {
    const request = createAgentRingAccessRequest(identity, input);

    expect(new TextDecoder().decode(canonicalAgentRingAccessPayload(request)))
      .toMatchInlineSnapshot(`
      "agent-intent:agent-ring-access:v1
      {"v":"4","publicKey":"02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9","encryptionPublicKey":"02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13","name":"Portfolio Bot","description":"Proposes portfolio operations.","source":"claude-code","trustchainId":"app18-root","expiresAt":"2099-01-01T00:00:00.000Z","channelEnvironment":"production","channelHost":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"}"
    `);
    expect(request.signature).toMatchInlineSnapshot(
      `"26a7c166dce44d880511e8d506bc6c1d2e15b31cd8d93d06db2debe327982f9d264cb1b0536547eb1812845a44e1041983589929296e12ea5c77d1192f84c712"`,
    );
    expect(createAgentRingAccessUrl("https://agents.example", request)).toMatchInlineSnapshot(
      `"https://agents.example/agents/ring-access?v=4&publicKey=02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9&encryptionPublicKey=02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13&name=Portfolio+Bot&description=Proposes+portfolio+operations.&source=claude-code&trustchainId=app18-root&expiresAt=2099-01-01T00%3A00%3A00.000Z&channelEnvironment=production&channelHost=02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5&signature=26a7c166dce44d880511e8d506bc6c1d2e15b31cd8d93d06db2debe327982f9d264cb1b0536547eb1812845a44e1041983589929296e12ea5c77d1192f84c712"`,
    );
  });

  it("authenticates every signed field", () => {
    const request = createAgentRingAccessRequest(identity, input);
    const search = agentRingAccessSearch(request);
    const otherKey = createSoftwareAgentIdentity().publicKey;

    const tampered: Record<string, string> = {
      publicKey: otherKey,
      encryptionPublicKey: otherKey,
      name: "Other Bot",
      description: "Other description",
      source: "codex",
      trustchainId: "other-root",
      expiresAt: "2098-01-01T00:00:00.000Z",
      channelEnvironment: "staging",
      channelHost: otherKey,
    };

    expect(validateAgentRingAccess(search, NOW)).toEqual({ status: "valid", request });
    const signedFields = Object.keys(search).filter((key) => key !== "v" && key !== "signature");
    expect(Object.keys(tampered).sort()).toEqual(signedFields.sort());
    for (const field of signedFields) {
      expect(validateAgentRingAccess({ ...search, [field]: tampered[field] }, NOW)).toMatchObject({
        status: "invalid",
        reason: "invalid-signature",
        message: "This agent ring access link has been changed or is not authentic.",
      });
    }
  });

  it("normalizes keys to lowercase before signing and accepts uppercase links", () => {
    const request = createAgentRingAccessRequest(identity, {
      ...input,
      encryptionPublicKey: encryptionPublicKey.toUpperCase(),
      channel: { environment: "production", hostPublicKey: hostPublicKey.toUpperCase() },
    });

    expect(request.encryptionPublicKey).toBe(encryptionPublicKey);
    expect(request.channel.hostPublicKey).toBe(hostPublicKey);
    const search = agentRingAccessSearch(request);
    expect(
      validateAgentRingAccess(
        {
          ...search,
          publicKey: request.publicKey.toUpperCase(),
          encryptionPublicKey: encryptionPublicKey.toUpperCase(),
          channelHost: hostPublicKey.toUpperCase(),
          signature: request.signature.toUpperCase(),
        },
        NOW,
      ),
    ).toEqual({ status: "valid", request });
  });

  it("rejects an expired link and an unsupported source", () => {
    const request = createAgentRingAccessRequest(identity, input);

    expect(validateAgentRingAccess(agentRingAccessSearch(request), new Date("2100-01-01"))).toEqual(
      {
        status: "invalid",
        reason: "expired",
        message: "This agent ring access link has expired.",
      },
    );
    expect(
      validateAgentRingAccess({ ...agentRingAccessSearch(request), source: "trading" }, NOW),
    ).toMatchObject({ status: "invalid", reason: "unsupported-source" });
    expect(() =>
      // @ts-expect-error trading is not an AgentSource; JS callers are still rejected.
      createAgentRingAccessRequest(identity, { ...input, source: "trading" }),
    ).toThrow(/not supported/);
  });

  it("accepts every supported agent source", () => {
    for (const source of SUPPORTED_AGENT_SOURCES) {
      const request = createAgentRingAccessRequest(identity, { ...input, source });
      expect(validateAgentRingAccess(agentRingAccessSearch(request), NOW)).toMatchObject({
        status: "valid",
        request: { source },
      });
    }
  });

  it("requires the channel, the encryption key and the agent's Trustchain", () => {
    const search = agentRingAccessSearch(createAgentRingAccessRequest(identity, input));

    for (const field of [
      "channelEnvironment",
      "channelHost",
      "encryptionPublicKey",
      "trustchainId",
    ]) {
      const { [field]: _, ...partial } = search;
      expect(validateAgentRingAccess(partial, NOW)).toMatchObject({
        status: "invalid",
        reason: "malformed",
        issues: [{ field, problem: "missing" }],
      });
    }
  });

  it("refuses an encryption key that is uncompressed, off the curve, or cut off", () => {
    const search = agentRingAccessSearch(createAgentRingAccessRequest(identity, input));
    const uncompressed = bytesToHex(secp256k1.Point.fromHex(encryptionPublicKey).toBytes(false));

    expect(
      validateAgentRingAccess({ ...search, encryptionPublicKey: uncompressed }, NOW),
    ).toMatchObject({
      reason: "malformed",
      issues: [{ field: "encryptionPublicKey", problem: "invalid-value" }],
    });
    expect(
      validateAgentRingAccess({ ...search, encryptionPublicKey: `02${"ff".repeat(32)}` }, NOW),
    ).toMatchObject({
      reason: "malformed",
      issues: [{ field: "encryptionPublicKey", problem: "invalid-value" }],
    });
    expect(
      validateAgentRingAccess(
        { ...search, encryptionPublicKey: encryptionPublicKey.slice(0, 40) },
        NOW,
      ),
    ).toMatchObject({
      reason: "malformed",
      message:
        'This agent ring access link is malformed: "encryptionPublicKey" is cut off (expected 66 hex characters).',
      issues: [{ field: "encryptionPublicKey", problem: "truncated", expectedLength: 66 }],
    });
    expect(() =>
      createAgentRingAccessRequest(identity, { ...input, encryptionPublicKey: uncompressed }),
    ).toThrow(/"encryptionPublicKey" has an invalid value/);
  });

  it("names the encryption key when the link is cut inside it", () => {
    const search = agentRingAccessSearch(createAgentRingAccessRequest(identity, input));
    const url = new URLSearchParams(search).toString();
    const cut = url.slice(
      0,
      url.indexOf("encryptionPublicKey=") + "encryptionPublicKey=".length + 30,
    );

    expect(
      validateAgentRingAccess(Object.fromEntries(new URLSearchParams(cut)), NOW),
    ).toMatchObject({
      reason: "malformed",
      message:
        'This agent ring access link is malformed: "encryptionPublicKey" is cut off (expected 66 hex characters).',
    });
  });

  it("refuses the agent's App-18 key as its encryption key, in any encoding", () => {
    const search = agentRingAccessSearch(createAgentRingAccessRequest(identity, input));
    const uncompressedSigningKey = bytesToHex(
      secp256k1.Point.fromHex(identity.publicKey).toBytes(false),
    );

    for (const link of [
      { ...search, encryptionPublicKey: identity.publicKey.toUpperCase() },
      { ...search, publicKey: uncompressedSigningKey, encryptionPublicKey: identity.publicKey },
    ]) {
      expect(validateAgentRingAccess(link, NOW)).toMatchObject({
        reason: "malformed",
        issues: [{ field: "encryptionPublicKey", problem: "invalid-value" }],
      });
    }
    expect(() =>
      createAgentRingAccessRequest(identity, { ...input, encryptionPublicKey: identity.publicKey }),
    ).toThrow(/"encryptionPublicKey" has an invalid value/);
  });

  it("refuses recovery parameters, unknown parameters and other link versions", () => {
    const search = agentRingAccessSearch(createAgentRingAccessRequest(identity, input));

    expect(
      validateAgentRingAccess(
        { ...search, recovery: "true", previousTrustchainId: "app18-root" },
        NOW,
      ),
    ).toMatchObject({
      reason: "malformed",
      issues: [
        { problem: "unexpected", parameter: "recovery" },
        { problem: "unexpected", parameter: "previousTrustchainId" },
      ],
    });
    expect(validateAgentRingAccess({ ...search, v: "3" }, NOW)).toMatchObject({
      reason: "malformed",
      issues: [{ field: "v", problem: "unsupported-version" }],
    });
  });

  it("does not accept a signature made for another link kind", () => {
    const recovery = createAgentRecoveryRequest(identity, {
      name: input.name,
      description: input.description,
      source: input.source,
      previousTrustchainId: input.trustchainId,
      expiresAt: input.expiresAt,
      channel: input.channel,
    });
    const search = agentRingAccessSearch(createAgentRingAccessRequest(identity, input));

    expect(
      validateAgentRingAccess(
        { ...search, signature: agentRecoverySearch(recovery).signature },
        NOW,
      ),
    ).toMatchObject({ status: "invalid", reason: "invalid-signature" });
  });

  it("tells ring access and recovery channel requests apart by version", () => {
    const request: AgentEnrollmentChannelRequest = createAgentRingAccessRequest(identity, input);
    const recovery: AgentEnrollmentChannelRequest = createAgentRecoveryRequest(identity, {
      name: input.name,
      description: input.description,
      source: input.source,
      previousTrustchainId: input.trustchainId,
      expiresAt: input.expiresAt,
      channel: input.channel,
    });

    expect(isAgentRingAccessRequest(request)).toBe(true);
    expect(isAgentRecoveryRequest(request)).toBe(false);
    expect(isAgentRingAccessRequest(recovery)).toBe(false);
    expect(isAgentRecoveryRequest(recovery)).toBe(true);
  });
});

describe("agent ring access completion", () => {
  const request = createAgentRingAccessRequest(identity, input);
  const granted = {
    agentPubkey: identity.publicKey,
    encryptionPublicKey,
    requestSignature: request.signature,
    environment: input.channel.environment,
    trustchainId: input.trustchainId,
    applicationPath: "m/0'/17'/0'",
  } as const;

  it("round-trips a grant in a fixed field order", () => {
    const grantedPayload = serializeAgentRingAccessCompletion(granted);

    expect(Object.keys(JSON.parse(grantedPayload))).toEqual([
      "version",
      "agentPubkey",
      "encryptionPublicKey",
      "requestSignature",
      "environment",
      "trustchainId",
      "applicationPath",
    ]);
    expect(parseAgentRingAccessCompletion(grantedPayload, request)).toEqual({
      version: 4,
      ...granted,
    });
  });

  it("matches the completion to the pending request", () => {
    const payload = serializeAgentRingAccessCompletion(granted);

    expect(() =>
      parseAgentRingAccessCompletion(payload, { ...request, publicKey: hostPublicKey }),
    ).toThrow("does not match the agent identity");
    expect(() =>
      parseAgentRingAccessCompletion(payload, { ...request, encryptionPublicKey: hostPublicKey }),
    ).toThrow("does not match the requested encryption key");
    expect(() =>
      parseAgentRingAccessCompletion(payload, { ...request, signature: "cd".repeat(64) }),
    ).toThrow("does not match the pending signed ring access request");
    expect(
      parseAgentRingAccessCompletion(payload, {
        ...request,
        publicKey: identity.publicKey.toUpperCase(),
        encryptionPublicKey: encryptionPublicKey.toUpperCase(),
        signature: request.signature.toUpperCase(),
      }),
    ).toMatchObject({ applicationPath: granted.applicationPath });
  });

  it("returns keys and the signature in lowercase whatever case the frontend sent", () => {
    const payload = serializeAgentRingAccessCompletion({
      ...granted,
      agentPubkey: granted.agentPubkey.toUpperCase(),
      encryptionPublicKey: granted.encryptionPublicKey.toUpperCase(),
      requestSignature: granted.requestSignature.toUpperCase(),
    });

    expect(parseAgentRingAccessCompletion(payload, request)).toEqual({ version: 4, ...granted });
  });

  it("refuses a grant on another Trustchain or environment than the agent's", () => {
    for (const [other, message] of [
      [{ trustchainId: "attacker-root" }, "returned another Trustchain than the agent's"],
      [{ environment: "staging" as const }, "returned another environment than the agent's"],
    ] as const) {
      expect(() =>
        parseAgentRingAccessCompletion(
          serializeAgentRingAccessCompletion({ ...granted, ...other }),
          request,
        ),
      ).toThrow(message);
    }
  });

  it("accepts the Key Ring stream and sections below it, nothing else", () => {
    for (const path of [
      "m/0'/17'/0'",
      "m/0'/17'/2'/5'/0'",
      "m/0'/17'/0'/7'/1'",
      "m/0'/17'/2147483647'",
    ]) {
      expect(isKeyRingApplicationPath(path)).toBe(true);
      expect(
        parseAgentRingAccessCompletion(
          serializeAgentRingAccessCompletion({ ...granted, applicationPath: path }),
          request,
        ),
      ).toMatchObject({ applicationPath: path });
    }
    for (const path of [
      "m/0'/17'",
      "m/0'/16'/0'",
      "m/0'/18'/0'",
      "m/0'/17'/0",
      "m/0'/17'/2'/5'",
      "m/0'/17'/0'/1'/2'/3'",
      "m/1'/17'/0'",
      "m/0'/17'/2147483648'",
      "m/0'/17'/007'",
      "m/0'/17'/-1'",
    ]) {
      expect(isKeyRingApplicationPath(path)).toBe(false);
      expect(() =>
        serializeAgentRingAccessCompletion({ ...granted, applicationPath: path }),
      ).toThrow("malformed");
    }
  });

  it("refuses malformed completions", () => {
    const payload = JSON.parse(serializeAgentRingAccessCompletion(granted)) as Record<
      string,
      unknown
    >;
    const { applicationPath: _, ...withoutPath } = payload;

    for (const value of [
      { ...payload, version: 3 },
      { ...payload, outcome: "granted" },
      { ...payload, extra: true },
      withoutPath,
      { ...payload, environment: "development" },
      { ...payload, trustchainId: "" },
      { ...payload, encryptionPublicKey: "zz".repeat(33) },
      { ...payload, requestSignature: "ab" },
      {
        version: 4,
        outcome: "declined",
        agentPubkey: identity.publicKey,
        encryptionPublicKey,
        requestSignature: request.signature,
      },
      [],
      null,
    ]) {
      expect(() => parseAgentRingAccessCompletion(JSON.stringify(value), request)).toThrow(
        "Agent ring access completion is malformed.",
      );
    }
    expect(() => parseAgentRingAccessCompletion("{", request)).toThrow("must be valid JSON");
  });

  it("serializes only the fields of a grant", () => {
    const untyped = { ...granted, outcome: "declined", version: 3 } as unknown as typeof granted;

    expect(JSON.parse(serializeAgentRingAccessCompletion(untyped))).toEqual({
      version: 4,
      ...granted,
    });
    expect(() =>
      serializeAgentRingAccessCompletion({
        agentPubkey: identity.publicKey,
        encryptionPublicKey,
        requestSignature: request.signature,
      } as unknown as typeof granted),
    ).toThrow("Agent ring access completion is malformed.");
    expectTypeOf<AgentRingAccessCompletion>().not.toHaveProperty("outcome");
  });
});
