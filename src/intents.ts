import { base58Decode, base58Encode } from "./base58.ts";
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
  intent:
    | (Omit<EvmSendIntent, "amount"> & { amount: string })
    | (Omit<SolanaSendIntent, "amount"> & { amount: string });
};

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
  if (isSolanaSendIntent(intent)) return envelope(encodeSolanaSendPayload(intent), nonce);
  const sender = evmAddress(intent.sender, "sender");
  const recipient = evmAddress(intent.recipient, "recipient");
  const amount = unsignedMinimal(normalizeAmount(intent.amount));
  const asset = encodeAsset(intent.asset);
  const description =
    intent.description === undefined
      ? new Uint8Array()
      : tlv(0x16, utf8(assertDescription(intent.description)));
  if (intent.network !== "ethereum") {
    throw new AgentIntentSdkError(
      `unsupported network "${String((intent as { network: unknown }).network)}".`,
    );
  }

  const payload = concatBytes(
    tlv(0x11, sender),
    tlv(0x12, recipient),
    tlv(0x13, amount),
    tlv(0x14, asset),
    tlv(0x15, Uint8Array.of(feeStrategyCode(intent.feeStrategy))),
    description,
    tlv(0x23, utf8(intent.network)),
  );
  return envelope(payload, nonce);
}

function encodeSolanaSendPayload(intent: SolanaSendIntent): Uint8Array {
  if ("feeStrategy" in intent) {
    throw new AgentIntentSdkError("a Solana send has no fee strategy.");
  }
  if (isTokenAsset(intent.asset)) {
    throw new AgentIntentSdkError("only native SOL sends are supported on Solana.");
  }
  const amount = normalizeAmount(intent.amount);
  if (amount > U64_MAX) throw new AgentIntentSdkError("amount must not exceed u64::MAX lamports.");
  return concatBytes(
    tlv(0x11, solanaAddress(intent.sender, "sender")),
    tlv(0x12, solanaAddress(intent.recipient, "recipient")),
    tlv(0x13, unsignedMinimal(amount)),
    tlv(0x14, encodeAsset(intent.asset)),
    intent.description === undefined
      ? new Uint8Array()
      : tlv(0x16, utf8(assertDescription(intent.description))),
    intent.memo === undefined ? new Uint8Array() : tlv(0x17, utf8(assertMemo(intent.memo))),
    tlv(0x23, utf8(intent.network)),
  );
}

function envelope(payload: Uint8Array, nonce: string): Uint8Array {
  return tlv(
    0xc1,
    concatBytes(
      tlv(0x01, Uint8Array.of(0x01)),
      tlv(0x02, Uint8Array.of(0x01)),
      tlv(0x10, payload),
      tlv(0xda, exactHex(nonce, 16, "nonce")),
    ),
  );
}

export function signCreateIntent(
  identity: AgentIdentity,
  intent: SendIntent,
  nonce = createNonce(),
): SignedCreateIntent {
  const tlvBytes = encodeSendIntentTlv(intent, nonce);
  return {
    issuer: identity.publicKey,
    signature: bytesToHex(identity.signDigest(sha256Digest(tlvBytes), SIGNATURE_DER)),
    nonce,
    intent: isSolanaSendIntent(intent) ? solanaWireIntent(intent) : evmWireIntent(intent),
  };
}

/** Solana addresses are already canonical (the encoder refused any other spelling). */
function solanaWireIntent(intent: SolanaSendIntent): SignedCreateIntent["intent"] {
  return {
    type: "send",
    network: intent.network,
    sender: intent.sender,
    recipient: intent.recipient,
    amount: normalizeAmount(intent.amount).toString(),
    asset: { type: "native" },
    ...(intent.memo === undefined ? {} : { memo: intent.memo }),
    ...(intent.description === undefined ? {} : { description: intent.description }),
  };
}

function evmWireIntent(intent: EvmSendIntent): SignedCreateIntent["intent"] {
  return {
    ...intent,
    sender: normalizeAddress(intent.sender),
    recipient: normalizeAddress(intent.recipient),
    amount: normalizeAmount(intent.amount).toString(),
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
  };
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
      : { description: assertDescription(intent.description) }),
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
    swap.description === undefined ? new Uint8Array() : tlv(0x16, utf8(swap.description)),
    tlv(0x18, utf8(swap.toAsset)),
    tlv(0x19, utf8(swap.toAmount)),
    tlv(0x23, utf8(swap.network)),
    tlv(0x24, utf8(swap.provider)),
  );
  return tlv(
    0xc1,
    concatBytes(
      tlv(0x01, Uint8Array.of(0x01)),
      tlv(0x02, Uint8Array.of(0x02)),
      tlv(0x10, payload),
      tlv(0xda, exactHex(nonce, 16, "nonce")),
    ),
  );
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

function normalizeAmount(value: bigint | string): bigint {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new AgentIntentSdkError("amount must be a non-negative decimal integer.");
  }
  return BigInt(text);
}

function normalizeAddress(value: string): string {
  return bytesToHex(evmAddress(value, "address"));
}

/**
 * The 32 bytes a Solana address denotes. Only its canonical spelling is
 * accepted, so the signed bytes pin the exact text the service stores.
 */
function solanaAddress(value: string, label: string): Uint8Array {
  const decoded = base58Decode(value, label);
  if (decoded.length !== 32) {
    throw new AgentIntentSdkError(`${label} must be a 32-byte base58 address.`);
  }
  if (base58Encode(decoded) !== value) {
    throw new AgentIntentSdkError(`${label} must be written in canonical base58.`);
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

function assertDescription(value: string): string {
  const length = Array.from(value).length;
  if (length < 1 || length > 280) {
    throw new AgentIntentSdkError("description must contain between 1 and 280 characters.");
  }
  return value;
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

function assertMemo(value: string): string {
  const length = Array.from(value).length;
  if (length < 1 || length > 280) {
    throw new AgentIntentSdkError("memo must contain between 1 and 280 characters.");
  }
  return value;
}

function identifier(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new AgentIntentSdkError(`${label} must be non-empty with no surrounding whitespace.`);
  }
  return value;
}

const U64_MAX = 2n ** 64n - 1n;

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value.normalize("NFC"));
}

function defaultRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
