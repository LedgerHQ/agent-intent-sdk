import { secp256k1 } from "@noble/curves/secp256k1.js";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import { createAgentIntentClient, staticAccessTokenProvider } from "./client.ts";
import { createSoftwareAgentIdentity, sha256Digest } from "./identity.ts";
import {
  encodeSendIntentTlv,
  serializeCreateIntent,
  signCreateIntent,
  type SendIntent,
  type SolanaSendIntent,
} from "./intents.ts";

const SECRET_KEY = "00".repeat(31) + "01";
const NONCE = "000102030405060708090a0b0c0d0e0f";
// The keys 0x11 × 32 and 0x22 × 32 of agent-intent-service ADR-0002's vectors.
const SENDER = "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2";
const RECIPIENT = "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3";
const SOLANA_SEND: SolanaSendIntent = {
  type: "send",
  network: "solana_devnet",
  sender: SENDER,
  recipient: RECIPIENT,
  amount: 1_000_000_000n,
  asset: { type: "native" },
};

describe("Solana send signing contract", () => {
  // agent-intent-service ADR-0002, "Pinned vectors": 1 SOL on devnet from 0x11 × 32 to 0x22 × 32.
  it.each([
    [
      "with description",
      { description: "Pay supplier" },
      "c1818b0101010201011071112011111111111111111111111111111111111111111111111111111111111111111220222222222222222222222222222222222222222222222222222222222222222213043b9aca00140820066e6174697665160c50617920737570706c696572230d736f6c616e615f6465766e6574da10000102030405060708090a0b0c0d0e0f",
      "7fc1c609c0d36770f4cc21f9f278c76e16312f639bb79e0db7166a1876e85989",
    ],
    [
      "without description",
      {},
      "c17d0101010201011063112011111111111111111111111111111111111111111111111111111111111111111220222222222222222222222222222222222222222222222222222222222222222213043b9aca00140820066e6174697665230d736f6c616e615f6465766e6574da10000102030405060708090a0b0c0d0e0f",
      "de5037814c8f1ef879a423843c6c265a6bdf272586ed05973a39d9bbb026413d",
    ],
    [
      "with description and memo",
      { description: "Pay supplier", memo: "Invoice 42" },
      "c18197010101020101107d112011111111111111111111111111111111111111111111111111111111111111111220222222222222222222222222222222222222222222222222222222222222222213043b9aca00140820066e6174697665160c50617920737570706c696572170a496e766f696365203432230d736f6c616e615f6465766e6574da10000102030405060708090a0b0c0d0e0f",
      "ab7326863a10c1be2c3b6012a141219c663284d87a2769de4d46a8d86a6174d8",
    ],
    [
      "with memo, without description",
      { memo: "Invoice 42" },
      "c18189010101020101106f112011111111111111111111111111111111111111111111111111111111111111111220222222222222222222222222222222222222222222222222222222222222222213043b9aca00140820066e6174697665170a496e766f696365203432230d736f6c616e615f6465766e6574da10000102030405060708090a0b0c0d0e0f",
      "d0ff6edc64dc7335313e9310f39596fe1e54f727debf0320b13099b215bd0f0a",
    ],
  ])("matches the backend's pinned vector %s", (_name, fields, tlvHex, digest) => {
    const encoded = encodeSendIntentTlv({ ...SOLANA_SEND, ...fields }, NONCE);

    expect(bytesToHex(encoded)).toBe(tlvHex);
    expect(bytesToHex(sha256Digest(encoded))).toBe(digest);
  });

  it("writes mainnet as `solana`, seven bytes shorter than devnet", () => {
    const devnet = bytesToHex(encodeSendIntentTlv(SOLANA_SEND, NONCE));
    const mainnet = bytesToHex(encodeSendIntentTlv({ ...SOLANA_SEND, network: "solana" }, NONCE));

    expect(mainnet).toBe(
      devnet
        .replace("c17d", "c176")
        .replace("1063", "105c")
        .replace("230d736f6c616e615f6465766e6574", "2306736f6c616e61"),
    );
  });

  it("signs the TLV digest and sends no fee strategy on the wire", () => {
    const identity = createSoftwareAgentIdentity(SECRET_KEY);
    const intent: SolanaSendIntent = { ...SOLANA_SEND, memo: "Invoice 42" };
    const request = signCreateIntent(identity, intent, NONCE);

    expect(
      secp256k1.verify(
        hexToBytes(request.signature),
        sha256Digest(encodeSendIntentTlv(intent, NONCE)),
        hexToBytes(identity.publicKey),
        { prehash: false, lowS: false, format: "der" },
      ),
    ).toBe(true);
    expect(JSON.parse(serializeCreateIntent(request)).intent).toEqual({
      type: "send",
      network: "solana_devnet",
      sender: SENDER,
      recipient: RECIPIENT,
      amount: 1_000_000_000,
      asset: { type: "native" },
      memo: "Invoice 42",
    });
  });

  it.each([
    [
      "a 31-byte address",
      { recipient: bs58.encode(new Uint8Array(31).fill(0x22)) },
      "recipient must be a 32-byte base58 address.",
    ],
    ["a non-base58 address", { sender: `${SENDER.slice(0, -1)}0` }, "sender must be base58."],
    [
      "a hex address",
      { sender: `0x${"11".repeat(32)}` },
      "sender must be a 32-byte base58 address.",
    ],
    [
      "an address longer than any 32-byte one",
      { sender: `1${SENDER}`.padEnd(45, "1") },
      "sender must be a 32-byte base58 address.",
    ],
    ["an amount past u64::MAX", { amount: 2n ** 64n }, "amount must not exceed u64::MAX lamports."],
    ["a zero amount", { amount: "0" }, "amount must be a positive decimal integer."],
    ["an empty memo", { memo: "" }, "memo must contain between 1 and 280 UTF-16 code units."],
    [
      "a 281-character memo",
      { memo: "m".repeat(281) },
      "memo must contain between 1 and 280 UTF-16 code units.",
    ],
    [
      // 141 emoji are 141 code points but 282 UTF-16 code units, which the service refuses.
      "a memo past 280 UTF-16 code units",
      { memo: "\u{1F4B0}".repeat(141) },
      "memo must contain between 1 and 280 UTF-16 code units.",
    ],
    ["a misspelled network", { network: "solana-devnet" }, 'unsupported network "solana-devnet".'],
    ["a fee strategy", { feeStrategy: "medium" }, "a Solana send has no fee strategy."],
    [
      "an SPL token",
      { asset: { type: "spl-token", assetReference: RECIPIENT } },
      "only native SOL sends are supported on Solana.",
    ],
  ])("refuses %s", (_name, fields, message) => {
    const intent = { ...SOLANA_SEND, ...fields } as unknown as SendIntent;

    expect(() => encodeSendIntentTlv(intent, NONCE)).toThrow(message);
  });

  it.each(["O", "I", "l", "+"])("refuses the non-base58 character %j", (character) => {
    const intent = { ...SOLANA_SEND, sender: `${SENDER.slice(1)}${character}` };

    expect(() => encodeSendIntentTlv(intent, NONCE)).toThrow("sender must be base58.");
  });

  it("decodes an address of leading 1s to the all-zero key", () => {
    const encoded = bytesToHex(
      encodeSendIntentTlv({ ...SOLANA_SEND, sender: "1".repeat(32) }, NONCE),
    );

    expect(encoded).toContain(`1120${"00".repeat(32)}1220${"22".repeat(32)}`);
  });

  it("accepts a memo of exactly 280 UTF-16 code units and an undefined fee strategy", () => {
    const intent = {
      ...SOLANA_SEND,
      memo: "\u{1F4B0}".repeat(140),
      feeStrategy: undefined,
    } as unknown as SendIntent;

    expect(() => encodeSendIntentTlv(intent, NONCE)).not.toThrow();
  });

  it("refuses a memo on an Ethereum send rather than submitting it unsigned", () => {
    const intent = {
      type: "send",
      network: "ethereum",
      sender: "0x" + "11".repeat(20),
      recipient: "0x" + "22".repeat(20),
      amount: "1",
      asset: { type: "native" },
      feeStrategy: "medium",
      memo: "Invoice 42",
    } as unknown as SendIntent;

    expect(() => encodeSendIntentTlv(intent, NONCE)).toThrow("an Ethereum send has no memo.");
  });

  it("accepts the largest u64 amount", () => {
    expect(() =>
      encodeSendIntentTlv({ ...SOLANA_SEND, amount: 2n ** 64n - 1n }, NONCE),
    ).not.toThrow();
  });

  it("posts a Solana send through the agent client", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("https://agent.ledger.com/intents/123", { status: 201 }));
    const client = createAgentIntentClient({
      bffBaseUrl: "https://bff.example/agent-intent",
      identity: createSoftwareAgentIdentity(SECRET_KEY),
      trustchainId: "trustchain-id",
      environment: "production",
      tokenProvider: staticAccessTokenProvider("agent-token"),
      fetch: fetcher,
    });

    await expect(client.createSendIntent({ ...SOLANA_SEND, network: "solana" })).resolves.toBe(
      "https://agent-intent.ledger.com/intents/123",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.intent).toMatchObject({ network: "solana", sender: SENDER, amount: 1_000_000_000 });
    expect(body.intent).not.toHaveProperty("feeStrategy");
  });
});
