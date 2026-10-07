import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { AgentIntentSdkError, bytesToHex, hexToBytes } from "./bytes.ts";
import { AgentIntentHttpError, createAgentIntentClient, type AgentIntentClient } from "./client.ts";
import type { AccessTokenProvider } from "./auth.ts";
import { createSoftwareAgentIdentity, sha256Digest } from "./identity.ts";
import {
  encodeSwapIntentTlv,
  normalizeSwapIntent,
  signSwapIntent,
  SWAP_INTENT_NETWORKS,
  type SwapIntent,
} from "./intents.ts";

const SECRET_KEY = "00".repeat(31) + "01";
const NONCE = "000102030405060708090a0b0c0d0e0f";

/** The intent behind `TransactionIntentTlvSpec.SwapExample` in agent-intent-service. */
const SWAP: SwapIntent = {
  type: "swap",
  network: "ethereum",
  sender: "0x" + "11".repeat(20),
  fromAsset: "ethereum/native",
  toAsset: "ethereum/erc20/usdc",
  fromAmount: "1.5",
  toAmount: "2000",
  provider: "changelly",
};

const hex = (bytes: Uint8Array) => bytesToHex(bytes);
const text = (value: string) => hex(new TextEncoder().encode(value));

describe("swap intent signing contract", () => {
  it("matches the backend's pinned TLV and digest vectors", () => {
    const encoded = encodeSwapIntentTlv(SWAP, NONCE);

    expect(hex(encoded)).toBe(
      "c176" +
        "010101" +
        "020102" +
        "105c" +
        "1114" +
        "11".repeat(20) +
        "1303" +
        "312e35" +
        "140f" +
        "657468657265756d2f6e6174697665" +
        "1813" +
        "657468657265756d2f65726332302f75736463" +
        "1904" +
        "32303030" +
        "2308" +
        "657468657265756d" +
        "2409" +
        "6368616e67656c6c79" +
        "da10" +
        NONCE,
    );
    expect(hex(sha256Digest(encoded))).toBe(
      "653f515e64c58c20502a91368d4e50c5d52423e87069787619a04f7e9aeb1d87",
    );
  });

  it("puts an optional description between the sold and the bought asset", () => {
    const encoded = encodeSwapIntentTlv({ ...SWAP, description: "Rebalance" }, NONCE);

    expect(payloadTags(encoded)).toEqual([0x11, 0x13, 0x14, 0x16, 0x18, 0x19, 0x23, 0x24]);
    expect(hex(encoded)).toContain(`1609${text("Rebalance")}`);
    expect(payloadTags(encodeSwapIntentTlv(SWAP, NONCE))).toEqual([
      0x11, 0x13, 0x14, 0x18, 0x19, 0x23, 0x24,
    ]);
  });

  it("encodes asset ids and the provider as opaque text", () => {
    const token = "ethereum/erc20/usd_tether__erc20_";
    const encoded = hex(
      encodeSwapIntentTlv(
        {
          ...SWAP,
          fromAsset: token,
          toAsset: "ethereum",
          fromAmount: "1",
          toAmount: "0.00036",
          provider: "oneinch",
        },
        NONCE,
      ),
    );

    expect(encoded).toContain(`14${token.length.toString(16)}${text(token)}`);
    expect(encoded).toContain(`1808${text("ethereum")}`);
    expect(encoded).toContain(`2407${text("oneinch")}`);
  });

  it("signs a different message when the direction, amounts or provider change", () => {
    const base = hex(encodeSwapIntentTlv(SWAP, NONCE));

    for (const changed of [
      { fromAsset: SWAP.toAsset, toAsset: SWAP.fromAsset },
      { fromAmount: SWAP.toAmount, toAmount: SWAP.fromAmount },
      { provider: "paraswap" },
    ]) {
      expect(hex(encodeSwapIntentTlv({ ...SWAP, ...changed }, NONCE))).not.toBe(base);
    }
  });

  it("normalizes text to NFC, like the backend", () => {
    expect(hex(encodeSwapIntentTlv({ ...SWAP, description: "café" }, NONCE))).toBe(
      hex(encodeSwapIntentTlv({ ...SWAP, description: "café" }, NONCE)),
    );
  });

  it("uses a long-form length once a field passes 127 bytes", () => {
    const encoded = hex(encodeSwapIntentTlv({ ...SWAP, description: "x".repeat(200) }, NONCE));

    expect(encoded).toContain(`1681c8${"78".repeat(200)}`);
  });

  it("produces a canonical DER signature over the TLV digest", () => {
    const identity = createSoftwareAgentIdentity(SECRET_KEY);
    const request = signSwapIntent(identity, SWAP, NONCE);

    expect(request.issuer).toBe(identity.publicKey);
    expect(request.nonce).toBe(NONCE);
    expect(verifies(request.issuer, request.signature, encodeSwapIntentTlv(SWAP, NONCE))).toBe(
      true,
    );
    expect(
      verifies(
        request.issuer,
        request.signature,
        encodeSwapIntentTlv({ ...SWAP, toAmount: "2001" }, NONCE),
      ),
    ).toBe(false);
  });

  it("returns the normalized intent it signed", () => {
    const request = signSwapIntent(
      createSoftwareAgentIdentity(SECRET_KEY),
      { ...SWAP, sender: "AB".repeat(20) },
      NONCE,
    );

    expect(request.intent.sender).toBe("0x" + "ab".repeat(20));
    expect(
      verifies(request.issuer, request.signature, encodeSwapIntentTlv(request.intent, NONCE)),
    ).toBe(true);
  });

  it("draws a fresh 16-byte nonce when none is given", () => {
    const identity = createSoftwareAgentIdentity(SECRET_KEY);
    const first = signSwapIntent(identity, SWAP);

    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(signSwapIntent(identity, SWAP).nonce).not.toBe(first.nonce);
  });
});

describe("normalizeSwapIntent", () => {
  it("writes the sender as lowercase 0x hex, with or without a prefix", () => {
    const upper = "AB".repeat(20);

    expect(normalizeSwapIntent({ ...SWAP, sender: upper }).sender).toBe("0x" + "ab".repeat(20));
    expect(normalizeSwapIntent({ ...SWAP, sender: `0x${upper}` }).sender).toBe(
      "0x" + "ab".repeat(20),
    );
  });

  it("accepts every network the service publishes", () => {
    for (const network of SWAP_INTENT_NETWORKS) {
      expect(normalizeSwapIntent({ ...SWAP, network }).network).toBe(network);
    }
  });

  it("keeps decimal amounts exactly as given", () => {
    const precise = normalizeSwapIntent({ ...SWAP, fromAmount: "12.000000000000000001" });

    expect(precise.fromAmount).toBe("12.000000000000000001");
  });

  it("counts a description in characters, not UTF-16 units", () => {
    expect(() => normalizeSwapIntent({ ...SWAP, description: "🔁".repeat(280) })).not.toThrow();
    expect(() => normalizeSwapIntent({ ...SWAP, description: "🔁".repeat(281) })).toThrow(
      AgentIntentSdkError,
    );
  });

  it.each([
    ["a short address", { sender: "0x" + "11".repeat(19) }],
    ["a non-hex address", { sender: "0xnot-an-address" }],
    ["a network without swaps", { network: "solana" as never }],
    ["a zero amount", { fromAmount: "0" }],
    ["a zero decimal amount", { toAmount: "0.000" }],
    ["a negative amount", { fromAmount: "-1" }],
    ["an exponent", { toAmount: "1e18" }],
    ["a trailing decimal point", { toAmount: "1." }],
    ["a leading zero", { fromAmount: "01" }],
    ["a thousands separator", { fromAmount: "1,5" }],
    ["a padded amount", { fromAmount: " 1" }],
    ["an empty sold asset", { fromAsset: "" }],
    ["a padded bought asset", { toAsset: " ethereum " }],
    ["an empty provider", { provider: "" }],
    ["an empty description", { description: "" }],
    ["an over-long description", { description: "x".repeat(281) }],
  ])("rejects %s", (_name, override) => {
    expect(() => normalizeSwapIntent({ ...SWAP, ...override })).toThrow(AgentIntentSdkError);
  });
});

describe("agent client swap intents", () => {
  function clientFor(
    fetcher: typeof fetch,
    tokenProvider: AccessTokenProvider = staticTokens("agent-token"),
  ): AgentIntentClient {
    return createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "staging",
      tokenProvider,
      fetch: fetcher,
    });
  }

  it("posts the signed swap and returns the canonical frontend deeplink", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("https://agent.ledger.com/intents/123?source=agent#review", { status: 201 }),
      );

    await expect(clientFor(fetcher).createSwapIntent(SWAP)).resolves.toBe(
      "https://agent-intent.ledger-test.com/intents/123?source=agent#review",
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toEqual(new URL("https://bff.example/agent-intent/v1/intents"));
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "text/plain",
        Authorization: "Bearer agent-token",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.intent).toEqual(SWAP);
    expect(verifies(String(body.issuer), String(body.signature), signedBytes(body))).toBe(true);
  });

  it("sends amounts as JSON strings so no digit is lost", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("https://x/intents/1", { status: 201 }));

    await clientFor(fetcher).createSwapIntent({ ...SWAP, fromAmount: "12.000000000000000001" });

    const body = String(fetcher.mock.calls[0]![1]?.body);
    expect(body).toContain('"fromAmount":"12.000000000000000001"');
    expect(body).toContain('"toAmount":"2000"');
  });

  it("rejects an invalid swap without calling the service", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(clientFor(fetcher).createSwapIntent({ ...SWAP, toAmount: "0" })).rejects.toThrow(
      "toAmount must be a positive decimal",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries once with a fresh token after a 401", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("https://bff.example/intents/ok", { status: 201 }));

    await expect(
      clientFor(fetcher, staticTokens("stale", "fresh")).createSwapIntent(SWAP),
    ).resolves.toBe("https://agent-intent.ledger-test.com/intents/ok");
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual([
      expect.objectContaining({ Authorization: "Bearer stale" }),
      expect.objectContaining({ Authorization: "Bearer fresh" }),
    ]);
  });

  it("surfaces the service's error message and type", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "nonce reused", type: "nonce_reused" }), {
        status: 409,
      }),
    );

    const error = await clientFor(fetcher)
      .createSwapIntent(SWAP)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AgentIntentHttpError);
    expect(error).toMatchObject({ status: 409, type: "nonce_reused", message: "nonce reused" });
  });

  it("rejects a deeplink the service should never send", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not a url", { status: 201 }));

    await expect(clientFor(fetcher).createSwapIntent(SWAP)).rejects.toThrow(
      "BFF returned an invalid intent deeplink.",
    );
  });
});

/** Replays `query` with each token in turn while `retryWhen` asks for another. */
function staticTokens(...tokens: string[]): AccessTokenProvider {
  return {
    async withAccessToken(query, retryWhen) {
      let result = await query(tokens[0]!);
      for (const token of tokens.slice(1)) {
        if (!retryWhen?.(result)) break;
        result = await query(token);
      }
      return result;
    },
  };
}

/** The TLV the service rebuilds from a posted body before checking its signature. */
function signedBytes(body: Record<string, unknown>): Uint8Array {
  return encodeSwapIntentTlv(body.intent as SwapIntent, String(body.nonce));
}

/** Children tags of the `0x10` payload inside the `0xC1` root. */
function payloadTags(encoded: Uint8Array): number[] {
  const root = children(encoded)[0]!;
  const payload = children(root.value).find((node) => node.tag === 0x10)!;
  return children(payload.value).map((node) => node.tag);
}

function children(bytes: Uint8Array): Array<{ tag: number; value: Uint8Array }> {
  const nodes: Array<{ tag: number; value: Uint8Array }> = [];
  for (let offset = 0; offset < bytes.length;) {
    const tag = bytes[offset++]!;
    let length = bytes[offset++]!;
    if (length & 0x80) {
      const size = length & 0x7f;
      length = 0;
      for (let index = 0; index < size; index += 1) length = length * 256 + bytes[offset++]!;
    }
    nodes.push({ tag, value: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  return nodes;
}

/** What the service's verifier does: DER secp256k1 over the SHA-256 of the canonical bytes. */
function verifies(publicKey: string, signature: string, message: Uint8Array): boolean {
  return secp256k1.verify(hexToBytes(signature), sha256Digest(message), hexToBytes(publicKey), {
    prehash: false,
    lowS: false,
    format: "der",
  });
}
