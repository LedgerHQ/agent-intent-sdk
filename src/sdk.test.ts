import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { buildAttestation, buildUnsignedChallengeTlv, createAgentTokenProvider } from "./auth.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import { createAgentIntentClient, staticAccessTokenProvider } from "./client.ts";
import {
  parseAgentEnrollmentCompletion,
  serializeAgentEnrollmentCompletion,
} from "./completion.ts";
import {
  agentEnrollmentSearch,
  canonicalAgentEnrollmentPayload,
  createAgentEnrollmentRequest,
  isAgentSource,
  SUPPORTED_AGENT_SOURCES,
  validateAgentEnrollment,
} from "./enrollment.ts";
import { createSoftwareAgentIdentity, sha256Digest } from "./identity.ts";
import {
  encodeSendIntentTlv,
  serializeCreateIntent,
  signCreateIntent,
  type SendIntent,
} from "./intents.ts";

const SECRET_KEY = "00".repeat(31) + "01";
const NONCE = "000102030405060708090a0b0c0d0e0f";
const SEND: SendIntent = {
  type: "send",
  network: "ethereum",
  sender: "0x" + "11".repeat(20),
  recipient: "0x" + "22".repeat(20),
  amount: 1_000_000_000_000_000_000n,
  asset: { type: "native" },
  feeStrategy: "medium",
  description: "Pay supplier",
};

describe("agent enrollment", () => {
  it("creates a request accepted by the shared validator", () => {
    const identity = createSoftwareAgentIdentity(SECRET_KEY);
    const request = createAgentEnrollmentRequest(identity, {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "hermes",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(validateAgentEnrollment(agentEnrollmentSearch(request))).toEqual({
      status: "valid",
      request,
    });
  });

  it("lists every supported agent runtime source", () => {
    expect(SUPPORTED_AGENT_SOURCES).toEqual([
      "openclaw",
      "hermes",
      "claude-code",
      "codex",
      "cursor",
      "muse",
      "grok-bot",
      "other",
    ]);
  });

  it.each(SUPPORTED_AGENT_SOURCES)("accepts a signed request from source %s", (source) => {
    const request = createAgentEnrollmentRequest(createSoftwareAgentIdentity(SECRET_KEY), {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(validateAgentEnrollment(agentEnrollmentSearch(request))).toEqual({
      status: "valid",
      request,
    });
  });

  it.each(["trading", "Claude Code", "claude_code", "ledger-official", "", undefined, null, 42])(
    "rejects uncontrolled source %s",
    (source) => {
      expect(isAgentSource(source)).toBe(false);
    },
  );

  it("rejects a link whose source is outside the controlled list", () => {
    const request = createAgentEnrollmentRequest(createSoftwareAgentIdentity(SECRET_KEY), {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "hermes",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(
      validateAgentEnrollment({ ...agentEnrollmentSearch(request), source: "ledger-official" }),
    ).toMatchObject({ status: "invalid", reason: "unsupported-source" });
  });

  it("matches the fixed version-1 canonical request and signature vector", () => {
    const request = createAgentEnrollmentRequest(createSoftwareAgentIdentity(SECRET_KEY), {
      name: "Portfolio Bot",
      description: "Proposes portfolio operations.",
      source: "hermes",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    expect(new TextDecoder().decode(canonicalAgentEnrollmentPayload(request)))
      .toMatchInlineSnapshot(`
      "agent-intent:agent-enrollment:v1
      {"v":"1","publicKey":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","name":"Portfolio Bot","description":"Proposes portfolio operations.","source":"hermes","expiresAt":"2099-01-01T00:00:00.000Z"}"
    `);
    expect(request.signature).toMatchInlineSnapshot(
      `"da7cc196a2ccf796fe84ff5123a68b7d0970ec7c80a06627e35fb41bc1ea2048646eb5eafb759affaff2fb692396ac8e6c568b98358fd8c70e54815b4e518087"`,
    );
  });

  it("accepts 80-character names and rejects longer names", () => {
    const identity = createSoftwareAgentIdentity(SECRET_KEY);
    const input = {
      description: "Proposes portfolio operations.",
      source: "hermes" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };

    expect(() =>
      createAgentEnrollmentRequest(identity, { ...input, name: "a".repeat(80) }),
    ).not.toThrow();
    expect(() =>
      createAgentEnrollmentRequest(identity, { ...input, name: "a".repeat(81) }),
    ).toThrow(/malformed/);
  });

  it("round-trips a completion for the pending agent identity", () => {
    const payload = serializeAgentEnrollmentCompletion({
      agentPubkey: "agent-pubkey",
      trustchainId: "trustchain-id",
    });

    expect(parseAgentEnrollmentCompletion(payload, "agent-pubkey")).toEqual({
      version: 1,
      agentPubkey: "agent-pubkey",
      trustchainId: "trustchain-id",
    });
  });

  it("round-trips safe direct App-16 metadata without secrets", () => {
    const payload = serializeAgentEnrollmentCompletion({
      agentPubkey: "agent-pubkey",
      trustchainId: "app-18-id",
      accountAccess: {
        mode: "direct-app16-key-reader",
        environment: "production",
        trustchainId: "app-16-id",
        applicationPath: "m/0'/16'/0'",
      },
    });
    expect(parseAgentEnrollmentCompletion(payload, "agent-pubkey")).toEqual({
      version: 2,
      agentPubkey: "agent-pubkey",
      trustchainId: "app-18-id",
      accountAccess: {
        mode: "direct-app16-key-reader",
        environment: "production",
        trustchainId: "app-16-id",
        applicationPath: "m/0'/16'/0'",
      },
    });
    expect(payload).not.toMatch(/walletSyncEncryptionKey|privatekey|access_token|serialized/i);
    expect(() =>
      parseAgentEnrollmentCompletion(
        JSON.stringify({
          ...JSON.parse(payload),
          accountAccess: {
            ...JSON.parse(payload).accountAccess,
            walletSyncEncryptionKey: "forbidden",
          },
        }),
        "agent-pubkey",
      ),
    ).toThrow(/supported version/);
  });

  it("rejects a completion for a different agent identity", () => {
    const payload = serializeAgentEnrollmentCompletion({
      agentPubkey: "other-agent",
      trustchainId: "trustchain-id",
    });

    expect(() => parseAgentEnrollmentCompletion(payload, "pending-agent")).toThrow(
      /does not match the pending agent identity/,
    );
  });
});

describe("agent authentication contract", () => {
  it("signs the provider-compatible challenge subset and attestation", () => {
    const fields = [
      [0x32, [0x21]],
      [0x01, [0x05]],
      [0x15, [0xaa, 0xbb]],
      [0x20, [0x61]],
      [0x02, [0x01]],
      [0x33, [0x04, 0xde, 0xad]],
      [0x60, [0x01, 0x00]],
      [0x12, [1, 2, 3]],
      [0x14, [0x01]],
      [0x16, [0x68, 0x00]],
    ] as const;
    const encoded = Uint8Array.from(
      fields.flatMap(([tag, value]) => [tag, value.length, ...value]),
    );

    expect(bytesToHex(buildUnsignedChallengeTlv(bytesToHex(encoded)))).toBe(
      bytesToHex(
        Uint8Array.from(
          fields
            .filter(([tag]) => [0x01, 0x02, 0x12, 0x16, 0x20, 0x60].includes(tag))
            .sort(([left], [right]) => left - right)
            .flatMap(([tag, value]) => [tag, value.length, ...value]),
        ),
      ),
    );
    expect(buildAttestation("00d6")).toBe("020430306436");
  });

  it("runs the agent Keycloak exchange once and caches the token", async () => {
    const challengeTlv = bytesToHex(
      Uint8Array.from(
        (
          [
            [0x01, [0x05]],
            [0x02, [0x01]],
            [0x12, [1, 2, 3]],
            [0x14, [0x01]],
            [0x15, [0xaa]],
            [0x16, [0x68]],
            [0x20, [0x61]],
            [0x32, [0x21]],
            [0x33, [0x04, 0xde]],
            [0x60, [0x01]],
          ] satisfies Array<[number, number[]]>
        ).flatMap(([tag, value]) => [tag, value.length, ...value]),
      ),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ tlv: challengeTlv, json: { host: "trustchain.example" } }),
      )
      .mockResolvedValueOnce(Response.json("authorization-code"))
      .mockResolvedValueOnce(Response.json({ access_token: "idp-token" }))
      .mockResolvedValueOnce(Response.json({ access_token: "agent-token", expires_in: 300 }));
    const provider = createAgentTokenProvider({
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      keycloak: {
        baseUrl: "https://keycloak.example",
        realm: "agent-intent-customers",
        clientId: "agentic-client",
        brokerId: "lkrp",
      },
      fetch: fetcher,
    });

    await expect(provider.withAccessToken((token) => Promise.resolve(token))).resolves.toBe(
      "agent-token",
    );
    await expect(provider.withAccessToken((token) => Promise.resolve(token))).resolves.toBe(
      "agent-token",
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/realms/agent-intent-customers/protocol/openid-connect/auth",
    );
  });

  it("retains Keycloak cookies across Node redirect chains", async () => {
    const challengeTlv = bytesToHex(
      Uint8Array.from(
        (
          [
            [0x01, [0x05]],
            [0x02, [0x01]],
            [0x12, [1, 2, 3]],
            [0x14, [0x01]],
            [0x15, [0xaa]],
            [0x16, [0x68]],
            [0x20, [0x61]],
            [0x32, [0x21]],
            [0x33, [0x04, 0xde]],
            [0x60, [0x01]],
          ] satisfies Array<[number, number[]]>
        ).flatMap(([tag, value]) => [tag, value.length, ...value]),
      ),
    );
    const redirect = new Response(null, {
      status: 303,
      headers: { Location: "https://keycloak.example/redirected-challenge" },
    });
    Object.defineProperty(redirect.headers, "getSetCookie", {
      value: () => ["KC_RESTART=restart-cookie; Path=/; Secure; HttpOnly"],
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect)
      .mockImplementationOnce((_input, init) => {
        expect(new Headers(init?.headers).get("cookie")).toBe("KC_RESTART=restart-cookie");
        return Promise.resolve(
          Response.json({ tlv: challengeTlv, json: { host: "trustchain.example" } }),
        );
      })
      .mockResolvedValueOnce(Response.json("authorization-code"))
      .mockResolvedValueOnce(Response.json({ access_token: "idp-token" }))
      .mockResolvedValueOnce(Response.json({ access_token: "agent-token", expires_in: 300 }));
    const provider = createAgentTokenProvider({
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      keycloak: {
        baseUrl: "https://keycloak.example",
        realm: "agent-intent-customers",
        clientId: "agentic-client",
        brokerId: "lkrp",
      },
      fetch: fetcher,
    });

    await expect(provider.withAccessToken((token) => Promise.resolve(token))).resolves.toBe(
      "agent-token",
    );
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
  });

  it("reports the failing authentication leg and server detail", async () => {
    const provider = createAgentTokenProvider({
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      keycloak: {
        baseUrl: "https://keycloak.example",
        realm: "agent-intent-customers",
        clientId: "agentic-client",
        brokerId: "lkrp",
      },
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ error: "Restart login cookie not found." }, { status: 400 }),
        ),
    });

    await expect(provider.withAccessToken((token) => Promise.resolve(token))).rejects.toThrow(
      "keycloak-challenge authentication request failed with HTTP 400: Restart login cookie not found.",
    );
  });
});

describe("intent signing contract", () => {
  it("matches the backend's pinned TLV and digest vectors", () => {
    const encoded = encodeSendIntentTlv(SEND, NONCE);

    expect(bytesToHex(encoded)).toBe(
      "c175" +
        "010101" +
        "020101" +
        "105b" +
        "1114" +
        "11".repeat(20) +
        "1214" +
        "22".repeat(20) +
        "1308" +
        "0de0b6b3a7640000" +
        "1408" +
        "2006" +
        "6e6174697665" +
        "150102" +
        "160c" +
        "50617920737570706c696572" +
        "2308" +
        "657468657265756d" +
        "da10" +
        NONCE,
    );
    expect(bytesToHex(sha256Digest(encoded))).toBe(
      "8072cd1f24dfb4181e0a2d404e48902586ff06dab87bffcc519d443b86cae390",
    );
  });

  it("produces a canonical DER signature over the TLV digest", () => {
    const identity = createSoftwareAgentIdentity(SECRET_KEY);
    const request = signCreateIntent(identity, SEND, NONCE);
    const digest = sha256Digest(encodeSendIntentTlv(SEND, NONCE));

    expect(
      secp256k1.verify(hexToBytes(request.signature), digest, hexToBytes(identity.publicKey), {
        prehash: false,
        lowS: false,
        format: "der",
      }),
    ).toBe(true);
  });

  it("serializes large amounts as exact JSON integers", () => {
    const request = signCreateIntent(createSoftwareAgentIdentity(SECRET_KEY), SEND, NONCE);

    expect(serializeCreateIntent(request)).toContain('"amount":1000000000000000000');
    expect(serializeCreateIntent(request)).not.toContain('"amount":"1000000000000000000"');
    expect(serializeCreateIntent(request)).toContain('"asset":{"type":"native"}');
  });
});

describe("agent client", () => {
  it("posts a signed intent and returns a canonical staging frontend deeplink", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("https://agent.ledger.com/intents/123?source=agent#review", {
        status: 201,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: fetcher,
    });

    await expect(client.createSendIntent(SEND)).resolves.toBe(
      "https://agent-intent.ledger-test.com/intents/123?source=agent#review",
    );
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer agent-token" }),
      }),
    );
  });

  it("uses the production frontend origin for production intents", async () => {
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "production",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("https://agent.ledger.com/intents/123", { status: 201 })),
    });

    await expect(client.createSendIntent(SEND)).resolves.toBe(
      "https://agent-intent.ledger.com/intents/123",
    );
  });
});
