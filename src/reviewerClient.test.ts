import { describe, expect, it, vi } from "vitest";
import type { AccessTokenProvider } from "./auth.ts";
import { AgentIntentSdkError } from "./bytes.ts";
import { AgentIntentHttpError, staticAccessTokenProvider } from "./client.ts";
import {
  createAgentIntentReviewerClient,
  isAgentIntentErrorType,
  isStaleRevisionError,
  type AgentIntentReviewerClient,
  type AgentIntentSwapCraftParameters,
} from "./reviewerClient.ts";

const BFF = "https://bff.example/agent-intent";
const INTENT_ID = "0192f7a4-0000-7000-8000-000000000001";

const RECORD = {
  id: INTENT_ID,
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
  context: { transactionId: "0xabc" },
};

const PROFILE = {
  agentPubkey: "02agent",
  profile: { name: "Treasury bot", description: "Pays suppliers", source: "claude-code" },
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
};

const PROFILE_WITH_ICON = {
  ...PROFILE,
  agentPubkey: "02iconic",
  profile: { ...PROFILE.profile, iconRef: "robot" },
};

const EVM_SIGNATURE = `0x${"ab".repeat(64)}1b`;
const SOLANA_SIGNATURE = "cd".repeat(64);

function reviewer(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const client = createAgentIntentReviewerClient({
    bffBaseUrl: BFF,
    tokenProvider: staticAccessTokenProvider("user-token"),
    fetch: fetcher,
  });
  return { client, fetcher };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function sentRequest(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = fetcher.mock.calls[0] ?? [];
  return { url: String(url), init: init ?? {} };
}

describe("reviewer client: intents", () => {
  it("lists one agent's intents with the status filter, page size and the next cursor", async () => {
    const { client, fetcher } = reviewer(
      new Response(JSON.stringify([RECORD]), { status: 200, headers: { "X-Ledger-Next": "next" } }),
    );

    await expect(
      client.listIntents({ status: ["created", "crafted"], pageSize: 10, agentPubkey: "02agent" }),
    ).resolves.toEqual({ intents: [RECORD], nextCursor: "next" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL(`${BFF}/v1/intents?status=created%2Ccrafted&pageSize=10&agentPubkey=02agent`),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
      }),
    );
  });

  it("continues a listing with only the cursor, whatever the other filters say", async () => {
    const { client, fetcher } = reviewer(json([]));

    await expect(
      client.listIntents({ cursor: "next", status: ["signed"], agentPubkey: "02agent" }),
    ).resolves.toEqual({ intents: [] });
    expect(sentRequest(fetcher).url).toBe(`${BFF}/v1/intents?cursor=next`);
  });

  it("refuses an empty agent filter without calling the BFF", async () => {
    const { client, fetcher } = reviewer();

    await expect(client.listIntents({ agentPubkey: "" })).rejects.toThrow(
      "agentPubkey must not be empty.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads an intent with its lifecycle context", async () => {
    const { client, fetcher } = reviewer(json(RECORD));

    await expect(client.getIntent(INTENT_ID)).resolves.toEqual(RECORD);
    expect(sentRequest(fetcher).url).toBe(`${BFF}/v1/intents/${INTENT_ID}`);
  });

  it("reads an intent not broadcast yet, whose context is empty", async () => {
    const notBroadcast = { ...RECORD, status: "crafted", context: {} };
    const { client } = reviewer(json(notBroadcast));

    await expect(client.getIntent(INTENT_ID)).resolves.toEqual(notBroadcast);
  });

  it("reads an intent without a context", async () => {
    const { context: _context, ...withoutContext } = RECORD;
    const { client } = reviewer(json(withoutContext));

    await expect(client.getIntent(INTENT_ID)).resolves.toEqual(withoutContext);
  });

  it.each([null, [], { transactionId: "" }])(
    "rejects an intent whose context is %j, a contract change",
    async (context) => {
      const { client } = reviewer(json({ ...RECORD, context }));

      await expect(client.getIntent(INTENT_ID)).rejects.toThrow(
        "BFF returned an intent with an unexpected shape.",
      );
    },
  );

  it.each([".", "..", ""])("refuses %j as an intent id", async (intentId) => {
    const { client, fetcher } = reviewer();

    await expect(client.getIntent(intentId)).rejects.toThrow(`Invalid intent id: "${intentId}".`);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads all-time counts, for one agent when asked", async () => {
    const stats = { total: 7, approved: 4, rejected: 1 };
    const { client, fetcher } = reviewer(json(stats));

    await expect(client.getIntentStats({ agentPubkey: "02agent" })).resolves.toEqual(stats);
    expect(sentRequest(fetcher).url).toBe(`${BFF}/v1/intents/stats?agentPubkey=02agent`);
  });

  it("refuses an empty agent filter for the counts without calling the BFF", async () => {
    const { client, fetcher } = reviewer();

    await expect(client.getIntentStats({ agentPubkey: "" })).rejects.toThrow(
      "agentPubkey must not be empty.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { total: 1, approved: -1, rejected: 0 },
    { total: 1.5, approved: 0, rejected: 0 },
    { total: "1", approved: 0, rejected: 0 },
  ])("rejects counts that aren't non-negative integers: %j", async (stats) => {
    const { client } = reviewer(json(stats));

    await expect(client.getIntentStats()).rejects.toThrow(
      "BFF returned intent counts with an unexpected shape.",
    );
  });

  it("rejects an intent with a POST and no body", async () => {
    const { client, fetcher } = reviewer(new Response(null, { status: 204 }));

    await expect(client.rejectIntent(INTENT_ID)).resolves.toBeUndefined();
    expect(sentRequest(fetcher)).toEqual({
      url: `${BFF}/v1/intents/${INTENT_ID}/reject`,
      init: {
        method: "POST",
        headers: { Accept: "application/json", Authorization: "Bearer user-token" },
      },
    });
  });

  it("keeps the BFF's message, status and type when a call fails", async () => {
    const { client } = reviewer(
      json({ message: "The network refused the transaction", type: "broadcast_rejected" }, 400),
    );

    const error = await client
      .submitSignature(INTENT_ID, { signature: EVM_SIGNATURE, revision: 1 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AgentIntentHttpError);
    expect(error).toMatchObject({
      message: "The network refused the transaction",
      status: 400,
      type: "broadcast_rejected",
    });
  });

  it("leaves the type undefined when the BFF sends none, as for a reject from another state", async () => {
    const { client } = reviewer(json({ message: "Intent is not pending" }, 400));

    await expect(client.rejectIntent(INTENT_ID)).rejects.toMatchObject({
      message: "Intent is not pending",
      status: 400,
      type: undefined,
    });
  });

  it("sends no agent User-Agent: the reviewer is the user's app, not an agent", async () => {
    const { client, fetcher } = reviewer(json(RECORD));

    await client.getIntent(INTENT_ID);
    expect(new Headers(sentRequest(fetcher).init.headers).has("User-Agent")).toBe(false);
  });

  const EVERY_METHOD: [
    string,
    (client: AgentIntentReviewerClient) => Promise<unknown>,
    () => Response,
  ][] = [
    ["listIntents", (client) => client.listIntents(), () => json([RECORD])],
    ["getIntent", (client) => client.getIntent(INTENT_ID), () => json(RECORD)],
    [
      "getIntentStats",
      (client) => client.getIntentStats(),
      () => json({ total: 0, approved: 0, rejected: 0 }),
    ],
    [
      "craftIntent",
      (client) => client.craftIntent(INTENT_ID),
      () => json({ rawTransaction: "0x02ef", revision: 1 }),
    ],
    [
      "submitSignature",
      (client) => client.submitSignature(INTENT_ID, { signature: EVM_SIGNATURE, revision: 1 }),
      () => json({ transactionId: "0xabc" }),
    ],
    [
      "rejectIntent",
      (client) => client.rejectIntent(INTENT_ID),
      () => new Response(null, { status: 204 }),
    ],
    ["listAgentProfiles", (client) => client.listAgentProfiles(), () => json([PROFILE])],
    ["getAgentProfile", (client) => client.getAgentProfile("02agent"), () => json(PROFILE)],
    [
      "createAgentProfile",
      (client) => client.createAgentProfile("02agent", PROFILE.profile),
      () => new Response(null, { status: 201 }),
    ],
    [
      "updateAgentProfile",
      (client) => client.updateAgentProfile("02agent", { name: "Renamed" }),
      () => new Response(null, { status: 200 }),
    ],
    [
      "deleteAgentProfile",
      (client) => client.deleteAgentProfile("02agent"),
      () => new Response(null, { status: 204 }),
    ],
  ];

  it.each(EVERY_METHOD)(
    "lets the token provider retry %s after a 401",
    async (_method, call, success) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("", { status: 401 }))
        .mockResolvedValueOnce(success());
      const tokens = ["expired-token", "fresh-token"];
      const tokenProvider: AccessTokenProvider = {
        withAccessToken: async (query, retryWhen) => {
          const first = await query(tokens[0]!);
          return retryWhen?.(first) ? query(tokens[1]!) : first;
        },
      };
      const client = createAgentIntentReviewerClient({
        bffBaseUrl: BFF,
        tokenProvider,
        fetch: fetcher,
      });

      await call(client);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenLastCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
        }),
      );
    },
  );

  it.each(EVERY_METHOD)(
    "fails %s with the 401 when the retried call is refused too",
    async (_method, call) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ message: "Token expired", type: "token_expired" }, 401))
        .mockResolvedValueOnce(json({ message: "Token expired", type: "token_expired" }, 401));
      const tokenProvider: AccessTokenProvider = {
        withAccessToken: async (query, retryWhen) => {
          const first = await query("expired-token");
          return retryWhen?.(first) ? query("refreshed-token") : first;
        },
      };
      const client = createAgentIntentReviewerClient({
        bffBaseUrl: BFF,
        tokenProvider,
        fetch: fetcher,
      });

      await expect(call(client)).rejects.toMatchObject({ status: 401, type: "token_expired" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
});

describe("reviewer client: crafting and signing", () => {
  const CRAFT = { rawTransaction: "0x02ef", revision: 2, details: { estimatedFee: "21000" } };

  it("crafts a send with no body", async () => {
    const { client, fetcher } = reviewer(json(CRAFT));

    await expect(client.craftIntent(INTENT_ID)).resolves.toEqual(CRAFT);
    expect(sentRequest(fetcher)).toEqual({
      url: `${BFF}/v1/intents/${INTENT_ID}/craft`,
      init: {
        method: "POST",
        headers: { Accept: "application/json", Authorization: "Bearer user-token" },
      },
    });
  });

  it("crafts a swap with its amounts as exact decimal strings", async () => {
    const { client, fetcher } = reviewer(json(CRAFT));

    await client.craftIntent(INTENT_ID, {
      recipient: "0x3333333333333333333333333333333333333333",
      data: "0xdeadbeef",
      amount: 12345678901234567890n,
      gasLimit: 387672n,
    });
    const { init } = sentRequest(fetcher);
    expect(init.headers).toEqual(expect.objectContaining({ "Content-Type": "application/json" }));
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "0x3333333333333333333333333333333333333333",
        data: "0xdeadbeef",
        amount: "12345678901234567890",
        gasLimit: "387672",
      }),
    );
  });

  it.each([
    [{ amount: -1n, gasLimit: 1n }, "A swap craft amount must be a non-negative bigint."],
    [{ amount: 0n, gasLimit: 0n }, "A swap craft gas limit must be a positive bigint."],
    [{ recipient: "" }, "A swap craft needs the router address and its calldata."],
    [{ data: "" }, "A swap craft needs the router address and its calldata."],
    [{ recipient: undefined }, "A swap craft needs the router address and its calldata."],
  ])("refuses swap parameters %o without calling the BFF", async (override, message) => {
    const { client, fetcher } = reviewer();
    const swap = { recipient: "0x33", data: "0x00", amount: 1n, gasLimit: 21000n, ...override };

    await expect(
      client.craftIntent(INTENT_ID, swap as AgentIntentSwapCraftParameters),
    ).rejects.toThrow(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a Solana craft, a base64 wire transaction", async () => {
    const craft = { rawTransaction: "AQAAAA==", revision: 1 };
    const { client } = reviewer(json(craft));

    await expect(client.craftIntent(INTENT_ID)).resolves.toEqual(craft);
  });

  it.each([
    { rawTransaction: "", revision: 1 },
    { rawTransaction: "not a transaction!", revision: 1 },
    { rawTransaction: "0xzz", revision: 1 },
    { rawTransaction: "0x2", revision: 1 },
    { rawTransaction: "0x02", revision: 0 },
    { rawTransaction: "0x02", revision: 1, details: "fee" },
  ])("rejects a crafted transaction with an unexpected shape: %j", async (craft) => {
    const { client } = reviewer(json(craft));

    await expect(client.craftIntent(INTENT_ID)).rejects.toThrow(
      "BFF returned a crafted transaction with an unexpected shape.",
    );
  });

  it("submits the signature with the revision of the signed craft", async () => {
    const { client, fetcher } = reviewer(json({ transactionId: "0xabc" }));

    await expect(
      client.submitSignature(INTENT_ID, { signature: EVM_SIGNATURE, revision: 2 }),
    ).resolves.toEqual({ transactionId: "0xabc" });
    expect(sentRequest(fetcher)).toEqual({
      url: `${BFF}/v1/intents/${INTENT_ID}/signature`,
      init: expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ signature: EVM_SIGNATURE, revision: 2 }),
      }),
    });
  });

  it.each([0, 1.5, Number.NaN])(
    "refuses %s as a craft revision without calling the BFF",
    async (revision) => {
      const { client, fetcher } = reviewer();

      await expect(
        client.submitSignature(INTENT_ID, { signature: EVM_SIGNATURE, revision }),
      ).rejects.toThrow(AgentIntentSdkError);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an EVM signature with v 1c", `0x${"ab".repeat(64)}1c`],
    // The frontend's vector, from a Ledger Button EIP-1559 signature (intentSignature.test.ts).
    [
      "a real EVM signature",
      "0x3796ba0dca371b3e73ee5cffd210ae7cc365a0762dad77762ee0fbf06dfad2bc3aab6cfa90ccd2091d4d59d2c405afa60b962e171315378dc4dfd1d04cbacfbd1c",
    ],
    ["a Solana signature", SOLANA_SIGNATURE],
  ])("submits %s", async (_shape, signature) => {
    const { client, fetcher } = reviewer(json({ transactionId: "0xabc" }));

    await client.submitSignature(INTENT_ID, { signature, revision: 1 });
    expect(sentRequest(fetcher).init.body).toBe(JSON.stringify({ signature, revision: 1 }));
  });

  it.each([
    ["an empty string", ""],
    ["a bare v", "0x1b"],
    ["an EVM signature with v 00", `0x${"ab".repeat(64)}00`],
    ["an EVM signature with v 01", `0x${"ab".repeat(64)}01`],
    ["an EVM signature in uppercase", `0x${"AB".repeat(64)}1B`],
    ["an EVM signature with a 31-byte r", `0x${"ab".repeat(63)}1b`],
    ["an EVM signature one byte too long", `0x${"ab".repeat(65)}1b`],
    ["an EVM signature without 0x", `${"ab".repeat(64)}1b`],
    ["a Solana signature with 0x", `0x${SOLANA_SIGNATURE}`],
    ["a Solana signature in uppercase", "CD".repeat(64)],
    ["a 63-byte Solana signature", "cd".repeat(63)],
  ])("refuses %s as a signature without calling the BFF", async (_shape, signature) => {
    const { client, fetcher } = reviewer();

    await expect(client.submitSignature(INTENT_ID, { signature, revision: 1 })).rejects.toThrow(
      "The signature must be lowercase hex: 0x + r‖s‖v with v 1b or 1c (EVM), or 64 bytes without 0x (Solana).",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tells a stale revision apart from other conflicts", async () => {
    const { client } = reviewer(
      json({ message: "Craft is stale", type: "stale_revision" }, 409),
      json({ message: "Another craft is running", type: "duplicate_event" }, 409),
    );
    const submission = { signature: EVM_SIGNATURE, revision: 1 };

    const stale = await client.submitSignature(INTENT_ID, submission).catch((e: unknown) => e);
    const other = await client.submitSignature(INTENT_ID, submission).catch((e: unknown) => e);
    expect(isStaleRevisionError(stale)).toBe(true);
    expect(isStaleRevisionError(other)).toBe(false);
  });

  it("keeps the other branch of a known HTTP error usable after the stale check", () => {
    const error: AgentIntentHttpError = new AgentIntentHttpError(
      "Refused",
      400,
      "broadcast_rejected",
    );

    // With a predicate on the whole class, `error` would be `never` here and this wouldn't compile.
    const outcome = isStaleRevisionError(error) ? "re-craft" : error.status;
    expect(outcome).toBe(400);
  });

  it("rejects a receipt without a transaction id", async () => {
    const { client } = reviewer(json({ transactionId: "" }));

    await expect(
      client.submitSignature(INTENT_ID, { signature: EVM_SIGNATURE, revision: 1 }),
    ).rejects.toThrow("BFF returned a signature receipt with an unexpected shape.");
  });
});

describe("reviewer client: agent profiles", () => {
  it("lists the agent profiles, with an icon or without", async () => {
    const { client, fetcher } = reviewer(json([PROFILE, PROFILE_WITH_ICON]));

    await expect(client.listAgentProfiles()).resolves.toEqual([PROFILE, PROFILE_WITH_ICON]);
    expect(sentRequest(fetcher).url).toBe(`${BFF}/v1/agent-profiles`);
  });

  it("reads one profile, and resolves undefined when the agent has none", async () => {
    const { client, fetcher } = reviewer(
      json(PROFILE),
      json({ message: "Agent profile not found." }, 404),
    );

    await expect(client.getAgentProfile("02agent")).resolves.toEqual(PROFILE);
    await expect(client.getAgentProfile("02other")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("throws on a profile read that fails for another reason", async () => {
    const { client } = reviewer(json({ message: "Not a member", type: "not_a_member" }, 403));

    await expect(client.getAgentProfile("02agent")).rejects.toBeInstanceOf(AgentIntentHttpError);
  });

  it.each([
    ["an HTML page", new Response("<html>Not Found</html>", { status: 404 })],
    ["a gateway's JSON", json({ message: "no Route matched with those values" }, 404)],
  ])("throws on a 404 from %s, not the BFF's missing profile", async (_source, response) => {
    const { client } = reviewer(response);

    await expect(client.getAgentProfile("02agent")).rejects.toMatchObject({ status: 404 });
  });

  it("creates, updates and deletes a profile under the encoded agent key", async () => {
    const { client, fetcher } = reviewer(
      new Response(null, { status: 201 }),
      new Response(null, { status: 200 }),
      new Response(null, { status: 204 }),
    );

    await client.createAgentProfile("02/agent", PROFILE.profile);
    await client.updateAgentProfile("02/agent", { name: "Renamed" });
    await client.deleteAgentProfile("02/agent");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body]),
    ).toEqual([
      [`${BFF}/v1/agent-profiles/02%2Fagent`, "POST", JSON.stringify(PROFILE.profile)],
      [`${BFF}/v1/agent-profiles/02%2Fagent`, "PATCH", JSON.stringify({ name: "Renamed" })],
      [`${BFF}/v1/agent-profiles/02%2Fagent`, "DELETE", undefined],
    ]);
  });

  it.each([
    ["no key", {}],
    ["only undefined values", { name: undefined }],
  ])("refuses a profile update with %s without calling the BFF", async (_shape, update) => {
    const { client, fetcher } = reviewer();

    await expect(client.updateAgentProfile("02agent", update)).rejects.toThrow(
      "A profile update needs at least one field.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the fields of an update that also has undefined ones", async () => {
    const { client, fetcher } = reviewer(new Response(null, { status: 200 }));

    await client.updateAgentProfile("02agent", { name: undefined, description: "Pays rent" });
    expect(sentRequest(fetcher).init.body).toBe(JSON.stringify({ description: "Pays rent" }));
  });

  it("refuses a profile key that would resolve to another endpoint", async () => {
    const { client, fetcher } = reviewer();

    await expect(client.deleteAgentProfile("..")).rejects.toThrow(
      'Invalid agent public key: "..".',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a profile listing with an unexpected shape", async () => {
    const { client } = reviewer(json([{ ...PROFILE, profile: null }]));

    await expect(client.listAgentProfiles()).rejects.toThrow(
      "BFF returned agent profiles with an unexpected shape.",
    );
  });
});

describe("BFF error types", () => {
  it("tells the BFF's error types from other strings", () => {
    expect(isAgentIntentErrorType("stale_revision")).toBe(true);
    expect(isAgentIntentErrorType("broadcast_rejected")).toBe(true);
    expect(isAgentIntentErrorType("not_a_type")).toBe(false);
  });
});
