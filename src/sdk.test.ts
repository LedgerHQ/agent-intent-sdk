import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { buildAttestation, buildUnsignedChallengeTlv, createAgentTokenProvider } from "./auth.ts";
import { AgentIntentSdkError, bytesToHex, hexToBytes } from "./bytes.ts";
import {
  AGENT_INTENT_FRONTEND_URLS,
  AgentIntentHttpError,
  buildAgentSetupPrompt,
  createAgentIntentClient,
  staticAccessTokenProvider,
} from "./client.ts";
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
import { isSendOperation, isSwapOperation, type ListAgentIntentsQuery } from "./intentPage.ts";
import { agentUserAgent } from "./userAgent.ts";
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
    expect(
      fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("user-agent")),
    ).toEqual(Array(4).fill(agentUserAgent()));
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
      "https://app.agents.ledger-test.com/intents/123?source=agent#review",
    );
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer agent-token",
          "User-Agent": agentUserAgent(),
        }),
      }),
    );
  });

  it("rejects an invalid send without calling the service", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: fetcher,
    });

    await expect(client.createSendIntent({ ...SEND, amount: "-1" })).rejects.toThrow(
      "amount must be a positive decimal integer.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rewrites the legacy frontend host to the production frontend origin", async () => {
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "production",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("https://agent-intent.ledger.com/intents/123", { status: 201 }),
        ),
    });

    await expect(client.createSendIntent(SEND)).resolves.toBe(
      "https://app.agents.ledger.com/intents/123",
    );
  });
});

describe("agent setup prompt", () => {
  const promptNaming = (app: string) =>
    "Use Ledger wallet-cli (npm package @ledgerhq/wallet-cli) and its agent skill with " +
    "`wallet-cli skill install --force`, then follow the skill's Agent Intent section to enroll an " +
    `agent with the app at ${app}.`;

  it.each([
    ["the production app by its host", "https://app.agents.ledger.com", "app.agents.ledger.com"],
    [
      "the staging app by its host",
      AGENT_INTENT_FRONTEND_URLS.staging,
      "app.agents.ledger-test.com",
    ],
    ["another https deploy by its host", "https://preview.example:8443", "preview.example:8443"],
    ["local dev by its http origin", "http://localhost:5173", "http://localhost:5173"],
  ])("names %s", (_case, appUrl, shown) => {
    expect(buildAgentSetupPrompt(appUrl)).toBe(promptNaming(shown));
  });

  it("rejects an app URL that isn't http(s)", () => {
    expect(() => buildAgentSetupPrompt("file:///index.html")).toThrow(
      'The Agent Intent app URL must be http(s), got "file:///index.html".',
    );
  });
});

describe("agent intent listing", () => {
  const RECORD = {
    id: "0192f7a4-0000-7000-8000-000000000001",
    agentPubkey: "02agent",
    status: "signed",
    intent: {
      type: "send",
      network: "ethereum",
      sender: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "1000000000000000",
      asset: { type: "native" },
      feeStrategy: "medium",
    },
    createdAt: "2026-10-07T10:00:00Z",
    updatedAt: "2026-10-07T10:05:00Z",
  };

  function listingClient(response: Response) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: fetcher,
    });
    return { client, fetcher };
  }

  it("lists the agent's intents with status filters, page size and the next cursor", async () => {
    const { client, fetcher } = listingClient(
      new Response(JSON.stringify([RECORD]), {
        status: 200,
        headers: { "X-Ledger-Next": "opaque-token", "X-Ledger-Page-Size": "5" },
      }),
    );

    await expect(
      client.listIntents({ status: ["signed", "broadcast"], pageSize: 5 }),
    ).resolves.toEqual({ intents: [RECORD], nextCursor: "opaque-token" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents?status=signed%2Cbroadcast&pageSize=5"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer agent-token" }),
      }),
    );
  });

  it("continues with only the cursor and reports the last page without one", async () => {
    const { client, fetcher } = listingClient(new Response("[]", { status: 200 }));

    await expect(
      client.listIntents({ cursor: "opaque-token", status: ["signed"], pageSize: 50 }),
    ).resolves.toEqual({ intents: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents?cursor=opaque-token"),
      expect.anything(),
    );
  });

  it("keeps a description that looks like an amount as it is", async () => {
    const record = { ...RECORD, intent: { ...RECORD.intent, description: 'pay "amount":1, now' } };
    const { client } = listingClient(new Response(JSON.stringify([record]), { status: 200 }));

    await expect(client.listIntents()).resolves.toEqual({ intents: [record] });
  });

  it("rejects a listing with the wrong shape", async () => {
    const { client } = listingClient(new Response('[{"id":1}]', { status: 200 }));

    await expect(client.listIntents()).rejects.toThrow(
      "BFF returned an intent listing with an unexpected shape.",
    );
  });

  it("rejects a listing that is not valid JSON, keeping the parse error as the cause", async () => {
    const { client } = listingClient(new Response('[{"id":"i1",', { status: 200 }));

    const error = await client.listIntents().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentIntentSdkError);
    expect(error).toMatchObject({
      message: "BFF returned an intent listing that is not valid JSON.",
      cause: expect.any(SyntaxError),
    });
  });

  const SOLANA_INTENT = {
    type: "send",
    network: "solana",
    sender: "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2",
    recipient: "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3",
    amount: "1000000",
    asset: { type: "spl-token", assetReference: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    memo: "Invoice 42",
  };
  const SWAP_INTENT = {
    type: "swap",
    network: "ethereum",
    sender: "0x1111111111111111111111111111111111111111",
    fromAsset: "ethereum",
    toAsset: "ethereum/erc20/usd__coin",
    fromAmount: "0.5",
    toAmount: "1250",
    provider: "oneinch",
    description: "Rebalance to USDC",
  };

  it("types Solana sends and swaps, and narrows them with the guards", async () => {
    const records = [
      { ...RECORD, intent: SOLANA_INTENT },
      { ...RECORD, id: "0192f7a4-0000-7000-8000-000000000002", intent: SWAP_INTENT },
    ];
    const { client } = listingClient(new Response(JSON.stringify(records), { status: 200 }));

    const [send, swap] = (await client.listIntents()).intents.map((record) => record.intent);
    expect([send, swap]).toEqual([SOLANA_INTENT, SWAP_INTENT]);
    expect([isSendOperation(send!), isSwapOperation(send!)]).toEqual([true, false]);
    expect([isSendOperation(swap!), isSwapOperation(swap!)]).toEqual([false, true]);
  });

  it.each([
    ["amount sent as a JSON number", RECORD.intent, { amount: 1000000000000000 }],
    ["network", RECORD.intent, { network: 7 }],
    ["sender", RECORD.intent, { sender: false }],
    ["recipient", RECORD.intent, { recipient: {} }],
    ["feeStrategy", RECORD.intent, { feeStrategy: 1 }],
    ["feeStrategy sent as null", RECORD.intent, { feeStrategy: null }],
    ["memo sent as null", SOLANA_INTENT, { memo: null }],
    ["description", RECORD.intent, { description: 123 }],
    ["asset", RECORD.intent, { asset: "native" }],
    ["asset type", RECORD.intent, { asset: { type: 3 } }],
    ["asset reference", RECORD.intent, { asset: { type: "erc20", assetReference: 1 } }],
    ["asset owner", RECORD.intent, { asset: { type: "erc20", assetOwner: [] } }],
    ["memo", SOLANA_INTENT, { memo: 42 }],
    ["fromAsset", SWAP_INTENT, { fromAsset: null }],
    ["toAsset", SWAP_INTENT, { toAsset: 1 }],
    ["fromAmount sent as a JSON number", SWAP_INTENT, { fromAmount: 1 }],
    ["toAmount sent as a JSON number", SWAP_INTENT, { toAmount: 42 }],
    ["provider", SWAP_INTENT, { provider: ["oneinch"] }],
    ["swap description", SWAP_INTENT, { description: false }],
  ])("rejects an intent whose %s has the wrong type", async (_field, intent, override) => {
    const record = { ...RECORD, intent: { ...intent, ...override } };
    const { client } = listingClient(new Response(JSON.stringify([record]), { status: 200 }));

    await expect(client.listIntents()).rejects.toThrow(
      "BFF returned an intent listing with an unexpected shape.",
    );
  });

  it.each([
    ["send", RECORD.intent, ["network", "sender", "recipient", "amount", "asset"]],
    [
      "swap",
      SWAP_INTENT,
      ["network", "sender", "fromAsset", "toAsset", "fromAmount", "toAmount", "provider"],
    ],
  ])("rejects a %s without one of its required fields", async (_type, intent, fields) => {
    for (const field of fields) {
      const { [field]: _omitted, ...rest } = intent as Record<string, unknown>;
      const { client } = listingClient(
        new Response(JSON.stringify([{ ...RECORD, intent: rest }]), { status: 200 }),
      );

      await expect(client.listIntents(), field).rejects.toThrow(
        "BFF returned an intent listing with an unexpected shape.",
      );
    }
  });

  it("doesn't narrow a hand-built send or swap that lacks its fields", () => {
    expect(isSendOperation({ type: "send" })).toBe(false);
    expect(isSwapOperation({ type: "swap", fromAmount: 1 })).toBe(false);
  });

  it("passes an intent type it doesn't know through as it is", async () => {
    const record = { ...RECORD, intent: { type: "stake", validator: "v1", amount: 5 } };
    const { client } = listingClient(new Response(JSON.stringify([record]), { status: 200 }));

    const { intents } = await client.listIntents();
    expect(intents).toEqual([record]);
    expect([isSendOperation(intents[0]!.intent), isSwapOperation(intents[0]!.intent)]).toEqual([
      false,
      false,
    ]);
  });

  it.each([
    ["a send", RECORD.intent],
    ["an intent type it doesn't know", { type: "stake", validator: "v1" }],
  ])("rejects a failureReason sent as null on %s", async (_case, intent) => {
    const record = { ...RECORD, intent, failureReason: null };
    const { client } = listingClient(new Response(JSON.stringify([record]), { status: 200 }));

    await expect(client.listIntents()).rejects.toThrow(
      new AgentIntentSdkError("BFF returned an intent listing with an unexpected shape."),
    );
  });

  it("keeps fields a newer BFF adds to an intent", async () => {
    const record = { ...RECORD, intent: { ...RECORD.intent, futureField: "x", hops: 2 } };
    const { client } = listingClient(new Response(JSON.stringify([record]), { status: 200 }));

    await expect(client.listIntents()).resolves.toEqual({ intents: [record] });
  });

  it("filters on cancelled intents", async () => {
    const record = { ...RECORD, status: "cancelled" };
    const { client, fetcher } = listingClient(
      new Response(JSON.stringify([record]), { status: 200 }),
    );

    await expect(client.listIntents({ status: ["cancelled"] })).resolves.toEqual({
      intents: [record],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents?status=cancelled"),
      expect.anything(),
    );
  });

  it("treats an empty cursor as a first page and sends the filters", async () => {
    const { client, fetcher } = listingClient(new Response("[]", { status: 200 }));

    await client.listIntents({ cursor: "", status: ["failed"], pageSize: 10 });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents?status=failed&pageSize=10"),
      expect.anything(),
    );
  });

  it.each([
    [{ pageSize: 7 }, "Unsupported pageSize: 7."],
    [{ status: ["signed", "pending"] }, "Unsupported intent status: pending."],
  ])("rejects an unsupported query before calling the BFF", async (query, message) => {
    const { client, fetcher } = listingClient(new Response("[]", { status: 200 }));

    await expect(client.listIntents(query as ListAgentIntentsQuery)).rejects.toThrow(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries once with a fresh token after a 401", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([RECORD]), { status: 200 }));
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider: {
        withAccessToken: async (query, retryWhen) => {
          const result = await query("stale-token");
          return retryWhen?.(result) ? query("fresh-token") : result;
        },
      },
      fetch: fetcher,
    });

    await expect(client.listIntents()).resolves.toEqual({ intents: [RECORD] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
      }),
    );
  });

  it("surfaces BFF errors with their status and type", async () => {
    const { client } = listingClient(
      new Response(JSON.stringify({ type: "invalid_cursor", message: "Invalid cursor" }), {
        status: 400,
      }),
    );

    const error = await client.listIntents({ cursor: "bad" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentIntentHttpError);
    expect(error).toMatchObject({ status: 400, type: "invalid_cursor", message: "Invalid cursor" });
  });
});

describe("agent intent lookup", () => {
  const RECORD = {
    id: "0192f7a4-0000-7000-8000-000000000001",
    agentPubkey: "02agent",
    status: "broadcast",
    intent: {
      type: "send",
      network: "ethereum",
      sender: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: "1000000000000000",
      asset: { type: "native" },
      feeStrategy: "medium",
    },
    createdAt: "2026-10-07T10:00:00Z",
    updatedAt: "2026-10-07T10:05:00Z",
  };

  function lookupClient(response: Response) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: fetcher,
    });
    return { client, fetcher };
  }

  it("reads one intent by id with the agent's token", async () => {
    const { client, fetcher } = lookupClient(new Response(JSON.stringify(RECORD), { status: 200 }));

    await expect(client.getIntent(RECORD.id)).resolves.toEqual(RECORD);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL(`https://bff.example/agent-intent/v1/intents/${RECORD.id}`),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer agent-token" }),
      }),
    );
  });

  it("encodes the id so it can't escape the intents path", async () => {
    const { client, fetcher } = lookupClient(new Response(JSON.stringify(RECORD), { status: 200 }));

    await client.getIntent("../stats?x=1");

    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents/..%2Fstats%3Fx%3D1"),
      expect.anything(),
    );
  });

  it.each(["", ".", ".."])(
    "rejects the id %j before calling the BFF, as it would resolve to another endpoint",
    async (intentId) => {
      const { client, fetcher } = lookupClient(
        new Response(JSON.stringify(RECORD), { status: 200 }),
      );

      await expect(client.getIntent(intentId)).rejects.toThrow(`Invalid intent id: "${intentId}".`);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects an amount sent as a JSON number", async () => {
    const body = JSON.stringify(RECORD).replace(
      '"amount":"1000000000000000"',
      '"amount":9007199254740993',
    );
    const { client } = lookupClient(new Response(body, { status: 200 }));

    await expect(client.getIntent(RECORD.id)).rejects.toThrow(
      "BFF returned an intent with an unexpected shape.",
    );
  });

  it("reports an unknown or foreign intent as a 404 HTTP error", async () => {
    const { client } = lookupClient(
      new Response(JSON.stringify({ message: "Intent not found" }), { status: 404 }),
    );

    const error = await client.getIntent(RECORD.id).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentIntentHttpError);
    expect(error).toMatchObject({ status: 404, message: "Intent not found" });
  });

  it("rejects an intent with the wrong shape", async () => {
    const { client } = lookupClient(new Response("[]", { status: 200 }));

    await expect(client.getIntent(RECORD.id)).rejects.toThrow(
      "BFF returned an intent with an unexpected shape.",
    );
  });

  it("rejects an intent that is not valid JSON", async () => {
    const { client } = lookupClient(new Response("{", { status: 200 }));

    await expect(client.getIntent(RECORD.id)).rejects.toThrow(
      "BFF returned an intent that is not valid JSON.",
    );
  });
});

describe("agent intent cancellation", () => {
  const INTENT_ID = "0192f7a4-0000-7000-8000-000000000001";

  function cancelClient(...responses: Response[]) {
    const fetcher = vi.fn<typeof fetch>();
    for (const response of responses) fetcher.mockResolvedValueOnce(response);
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider: {
        withAccessToken: async (query, retryWhen) => {
          const result = await query("agent-token");
          return retryWhen?.(result) ? query("fresh-token") : result;
        },
      },
      fetch: fetcher,
    });
    return { client, fetcher };
  }

  it("cancels one intent by id with the agent's token", async () => {
    const { client, fetcher } = cancelClient(new Response(null, { status: 204 }));

    await expect(client.cancelIntent(INTENT_ID)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL(`https://bff.example/agent-intent/v1/intents/${INTENT_ID}/cancel`),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer agent-token" }),
      }),
    );
  });

  it("encodes the id so it can't escape the intent's path", async () => {
    const { client, fetcher } = cancelClient(new Response(null, { status: 204 }));

    await client.cancelIntent("../stats?x=1");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://bff.example/agent-intent/v1/intents/..%2Fstats%3Fx%3D1/cancel"),
      expect.anything(),
    );
  });

  it.each(["", ".", ".."])("rejects the id %j before calling the BFF", async (intentId) => {
    const { client, fetcher } = cancelClient(new Response(null, { status: 204 }));

    await expect(client.cancelIntent(intentId)).rejects.toThrow(
      `Invalid intent id: "${intentId}".`,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [400, "Illegal transition from IntentRejected to IntentCancelled"],
    [404, "Intent not found"],
  ])("reports a %i from the BFF as an HTTP error without a type", async (status, message) => {
    const { client } = cancelClient(new Response(JSON.stringify({ message }), { status }));

    const error = await client.cancelIntent(INTENT_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentIntentHttpError);
    expect(error).toMatchObject({ status, type: undefined, message });
  });

  it("resolves when the service reports the intent already cancelled", async () => {
    const { client } = cancelClient(new Response(null, { status: 204 }));

    await expect(client.cancelIntent(INTENT_ID)).resolves.toBeUndefined();
  });

  it("retries once with a fresh token after a 401", async () => {
    const { client, fetcher } = cancelClient(
      new Response(null, { status: 401 }),
      new Response(null, { status: 204 }),
    );

    await expect(client.cancelIntent(INTENT_ID)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
      }),
    );
  });

  it("gives up when the retry also gets a 401", async () => {
    const { client, fetcher } = cancelClient(
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    );

    const error = await client.cancelIntent(INTENT_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentIntentHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
