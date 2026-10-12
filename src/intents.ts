import bs58 from "bs58";
import { AgentIntentSdkError, bytesToHex, concatBytes, hexToBytes } from "./bytes.ts";
import { SIGNATURE_DER, sha256Digest, type AgentIdentity } from "./identity.ts";

export type FeeStrategy = "slow" | "medium" | "fast";

export type NativeAsset = {
  type: "native";
};
export type TokenAsset = {
  type: string;
  assetReference: string;
  assetOwner?: string;
};
export type Asset = NativeAsset | TokenAsset;

export type EvmSendIntent = {
  type: "send";
  network: "ethereum";
  sender: string;
  recipient: string;
  amount: bigint | string;
  asset: Asset;
  feeStrategy: FeeStrategy;
  description?: string;
};

export type SolanaNetwork = "solana" | "solana_devnet";

/**
 * A native SOL send. Addresses are canonical base58, `amount` is in lamports
 * (at most `u64::MAX`), and there is no fee strategy: the service sets the
 * priority fee itself. `memo` goes on chain with the transfer.
 */
export type SolanaSendIntent = {
  type: "send";
  network: SolanaNetwork;
  sender: string;
  recipient: string;
  amount: bigint | string;
  asset: NativeAsset;
  memo?: string;
  description?: string;
};

export type SendIntent = EvmSendIntent | SolanaSendIntent;

export type SignedCreateIntent = {
  issuer: string;
  signature: string;
  nonce: string;
  intent: WithWireAmount<SendIntent>;
};

// Distributes over the union, so each send keeps its own fields with a string amount.
type WithWireAmount<T> = T extends unknown ? Omit<T, "amount"> & { amount: string } : never;

/** EVM networks the Agent Intent service accepts a Swap on. */
export const SWAP_INTENT_NETWORKS = ["ethereum", "ethereum_sepolia", "arc_testnet"] as const;
export type SwapIntentNetwork = (typeof SWAP_INTENT_NETWORKS)[number];

export type SwapIntent = {
  type: "swap";
  network: SwapIntentNetwork;
  sender: string;
  fromAsset: string;
  toAsset: string;
  // Human-unit decimals such as "0.1", not base units.
  fromAmount: string;
  toAmount: string;
  provider: string;
  description?: string;
};

export type SignedSwapIntent = {
  issuer: string;
  signature: string;
  nonce: string;
  intent: SwapIntent;
};

const textEncoder = new TextEncoder();
const U64_MAX = 2n ** 64n - 1n;
const SOLANA_ADDRESS_MAX_LENGTH = 44;

export function createNonce(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  const nonce = randomBytes(16);
  if (nonce.length !== 16) {
    throw new AgentIntentSdkError("random source must return exactly 16 nonce bytes.");
  }
  return bytesToHex(nonce);
}

export function isSolanaSendIntent(intent: SendIntent): intent is SolanaSendIntent {
  return intent.network === "solana" || intent.network === "solana_devnet";
}

/**
 * The canonical TLV an agent signs. A Solana send uses the same envelope and
 * payload layout as an EVM one (agent-intent-service ADR-0002): its addresses
 * are the 32 bytes their base58 denotes, it has no `0x15` fee strategy, and it
 * may carry a `0x17` memo.
 */
export function encodeSendIntentTlv(intent: SendIntent, nonce: string): Uint8Array {
  return envelope(encodeSend(intent).payload, nonce);
}

export function signCreateIntent(
  identity: AgentIdentity,
  intent: SendIntent,
  nonce = createNonce(),
): SignedCreateIntent {
  const encoded = encodeSend(intent);
  const tlvBytes = envelope(encoded.payload, nonce);
  return {
    issuer: identity.publicKey,
    signature: bytesToHex(identity.signDigest(sha256Digest(tlvBytes), SIGNATURE_DER)),
    nonce,
    intent: encoded.intent,
  };
}

type EncodedSend = { payload: Uint8Array; intent: SignedCreateIntent["intent"] };

function encodeSend(intent: SendIntent): EncodedSend {
  switch (intent.network) {
    case "ethereum":
      return encodeEvmSend(intent);
    case "solana":
    case "solana_devnet":
      return encodeSolanaSend(intent);
    default: {
      const unsupported: never = intent;
      throw new AgentIntentSdkError(
        `unsupported network "${String((unsupported as { network: unknown }).network)}".`,
      );
    }
  }
}

function encodeEvmSend(intent: EvmSendIntent): EncodedSend {
  // An EVM send has no memo; refuse one instead of putting it on the wire unsigned.
  if ((intent as { memo?: unknown }).memo !== undefined) {
    throw new AgentIntentSdkError("an Ethereum send has no memo.");
  }
  const amount = normalizeAmount(intent.amount);
  const payload = concatBytes(
    tlv(0x11, evmAddress(intent.sender, "sender")),
    tlv(0x12, evmAddress(intent.recipient, "recipient")),
    tlv(0x13, unsignedMinimal(amount)),
    tlv(0x14, encodeAsset(intent.asset)),
    tlv(0x15, Uint8Array.of(feeStrategyCode(intent.feeStrategy))),
    optionalText(0x16, intent.description, "description"),
    tlv(0x23, utf8(intent.network)),
  );
  return {
    payload,
    intent: {
      ...intent,
      sender: normalizeAddress(intent.sender),
      recipient: normalizeAddress(intent.recipient),
      amount: amount.toString(),
      ...(isTokenAsset(intent.asset)
        ? {
            asset: {
              ...intent.asset,
              assetReference: normalizeAddress(intent.asset.assetReference),
              ...(intent.asset.assetOwner === undefined
                ? {}
                : { assetOwner: normalizeAddress(intent.asset.assetOwner) }),
            },
          }
        : { asset: { type: "native" as const } }),
    },
  };
}

function encodeSolanaSend(intent: SolanaSendIntent): EncodedSend {
  if ((intent as { feeStrategy?: unknown }).feeStrategy !== undefined) {
    throw new AgentIntentSdkError("a Solana send has no fee strategy.");
  }
  if (isTokenAsset(intent.asset)) {
    throw new AgentIntentSdkError("only native SOL sends are supported on Solana.");
  }
  const amount = normalizeAmount(intent.amount);
  if (amount > U64_MAX) throw new AgentIntentSdkError("amount must not exceed u64::MAX lamports.");
  const payload = concatBytes(
    tlv(0x11, solanaAddress(intent.sender, "sender")),
    tlv(0x12, solanaAddress(intent.recipient, "recipient")),
    tlv(0x13, unsignedMinimal(amount)),
    tlv(0x14, encodeAsset(intent.asset)),
    optionalText(0x16, intent.description, "description"),
    optionalText(0x17, intent.memo, "memo"),
    tlv(0x23, utf8(intent.network)),
  );
  return {
    payload,
    // The addresses decoded to 32 bytes above, so their spelling is already canonical.
    intent: {
      type: "send",
      network: intent.network,
      sender: intent.sender,
      recipient: intent.recipient,
      amount: amount.toString(),
      asset: { type: "native" },
      ...(intent.memo === undefined ? {} : { memo: intent.memo }),
      ...(intent.description === undefined ? {} : { description: intent.description }),
    },
  };
}

function envelope(payload: Uint8Array, nonce: string, intentType = 0x01): Uint8Array {
  return tlv(
    0xc1,
    concatBytes(
      tlv(0x01, Uint8Array.of(0x01)),
      tlv(0x02, Uint8Array.of(intentType)),
      tlv(0x10, payload),
      tlv(0xda, exactHex(nonce, 16, "nonce")),
    ),
  );
}

export function normalizeSwapIntent(intent: SwapIntent): SwapIntent {
  if (intent.type !== "swap") {
    throw new AgentIntentSdkError(`expected a swap intent, got type "${String(intent.type)}".`);
  }
  if (!(SWAP_INTENT_NETWORKS as readonly string[]).includes(intent.network)) {
    throw new AgentIntentSdkError(
      `unsupported swap network "${String(intent.network)}"; use one of ${SWAP_INTENT_NETWORKS.join(", ")}.`,
    );
  }
  return {
    type: "swap",
    network: intent.network,
    sender: `0x${bytesToHex(evmAddress(intent.sender, "sender"))}`,
    fromAsset: identifier(intent.fromAsset, "fromAsset"),
    toAsset: identifier(intent.toAsset, "toAsset"),
    fromAmount: naturalAmount(intent.fromAmount, "fromAmount"),
    toAmount: naturalAmount(intent.toAmount, "toAmount"),
    provider: identifier(intent.provider, "provider"),
    ...(intent.description === undefined
      ? {}
      : { description: assertBoundedText(intent.description, "description") }),
  };
}

export function encodeSwapIntentTlv(intent: SwapIntent, nonce: string): Uint8Array {
  return encodeNormalizedSwapIntentTlv(normalizeSwapIntent(intent), nonce);
}

function encodeNormalizedSwapIntentTlv(swap: SwapIntent, nonce: string): Uint8Array {
  const payload = concatBytes(
    tlv(0x11, evmAddress(swap.sender, "sender")),
    tlv(0x13, utf8(swap.fromAmount)),
    tlv(0x14, utf8(swap.fromAsset)),
    optionalText(0x16, swap.description, "description"),
    tlv(0x18, utf8(swap.toAsset)),
    tlv(0x19, utf8(swap.toAmount)),
    tlv(0x23, utf8(swap.network)),
    tlv(0x24, utf8(swap.provider)),
  );
  return envelope(payload, nonce, 0x02);
}

export function signSwapIntent(
  identity: AgentIdentity,
  intent: SwapIntent,
  nonce = createNonce(),
): SignedSwapIntent {
  const normalizedIntent = normalizeSwapIntent(intent);
  const tlvBytes = encodeNormalizedSwapIntentTlv(normalizedIntent, nonce);
  return {
    issuer: identity.publicKey,
    signature: bytesToHex(identity.signDigest(sha256Digest(tlvBytes), SIGNATURE_DER)),
    nonce,
    intent: normalizedIntent,
  };
}

/**
 * JSON has arbitrary-size integer syntax, but JavaScript numbers do not. This
 * serializer keeps the amount as exact integer digits on the wire.
 */
export function serializeCreateIntent(request: SignedCreateIntent): string {
  const marker = "__AGENT_INTENT_EXACT_AMOUNT__";
  const json = JSON.stringify({
    ...request,
    intent: { ...request.intent, amount: marker },
  });
  return json.replace(`"${marker}"`, request.intent.amount);
}

function encodeAsset(asset: Asset): Uint8Array {
  if (!isTokenAsset(asset)) return tlv(0x20, utf8("native"));
  if (!asset.type || asset.type === "native") {
    throw new AgentIntentSdkError("token asset type must be non-empty and cannot be native.");
  }
  return concatBytes(
    tlv(0x20, utf8(asset.type)),
    tlv(0x21, evmAddress(asset.assetReference, "assetReference")),
    ...(asset.assetOwner === undefined
      ? []
      : [tlv(0x22, evmAddress(asset.assetOwner, "assetOwner"))]),
  );
}

function isTokenAsset(asset: Asset): asset is TokenAsset {
  return asset.type !== "native";
}

function feeStrategyCode(strategy: FeeStrategy): number {
  switch (strategy) {
    case "slow":
      return 0x01;
    case "medium":
      return 0x02;
    case "fast":
      return 0x03;
  }
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new AgentIntentSdkError("TLV length must be a non-negative safe integer.");
  }
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining & 0xff);
  }
  if (bytes.length > 4) throw new AgentIntentSdkError("TLV value is too long.");
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function unsignedMinimal(value: bigint): Uint8Array {
  if (value === 0n) return Uint8Array.of(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return hexToBytes(hex);
}

/** The service's `Amount` is a positive integer on every network. */
function normalizeAmount(value: bigint | string): bigint {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new AgentIntentSdkError("amount must be a positive decimal integer.");
  }
  return BigInt(text);
}

function normalizeAddress(value: string): string {
  return bytesToHex(evmAddress(value, "address"));
}

/**
 * The 32 bytes a Solana address denotes. Base58 maps text to bytes one to one
 * (each leading `1` is a leading zero byte), so any text that decodes to exactly
 * 32 bytes is the canonical spelling the service re-encodes and stores.
 */
function solanaAddress(value: string, label: string): Uint8Array {
  // 32 bytes take at most 44 base58 digits; longer text never reaches the slow decoder.
  if (value.length > SOLANA_ADDRESS_MAX_LENGTH) {
    throw new AgentIntentSdkError(`${label} must be a 32-byte base58 address.`);
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new AgentIntentSdkError(`${label} must be base58.`);
  }
  if (decoded.length !== 32) {
    throw new AgentIntentSdkError(`${label} must be a 32-byte base58 address.`);
  }
  return decoded;
}

function evmAddress(value: string, label: string): Uint8Array {
  return exactHex(value, 20, label);
}

function exactHex(value: string, bytes: number, label: string): Uint8Array {
  const decoded = hexToBytes(value, label);
  if (decoded.length !== bytes) {
    throw new AgentIntentSdkError(`${label} must contain exactly ${bytes} bytes.`);
  }
  return decoded;
}

// The service's `NaturalAmount`: positive decimal text, no sign, exponent or leading zeros.
const NATURAL_AMOUNT = /^(?!0(?:\.0+)?$)(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function naturalAmount(value: string, label: string): string {
  if (!NATURAL_AMOUNT.test(value)) {
    throw new AgentIntentSdkError(
      `${label} must be a positive decimal such as 0.1 or 2000, with no sign, exponent or spaces.`,
    );
  }
  return value;
}

/**
 * The service bounds a description and a memo with `MaxLength[280]` on a JVM
 * `String`, which counts UTF-16 code units, as `String.length` does here: a
 * character outside the Basic Multilingual Plane (most emoji) counts twice.
 */
function assertBoundedText(value: string, label: string): string {
  if (value.length < 1 || value.length > 280) {
    throw new AgentIntentSdkError(`${label} must contain between 1 and 280 UTF-16 code units.`);
  }
  return value;
}

function optionalText(tag: number, value: string | undefined, label: string): Uint8Array {
  return value === undefined ? new Uint8Array() : tlv(tag, utf8(assertBoundedText(value, label)));
}

function identifier(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new AgentIntentSdkError(`${label} must be non-empty with no surrounding whitespace.`);
  }
  return value;
}

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value.normalize("NFC"));
}

function defaultRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
