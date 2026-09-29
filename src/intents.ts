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

export type SendIntent = {
  type: "send";
  network: "ethereum";
  sender: string;
  recipient: string;
  amount: bigint | string;
  asset: Asset;
  feeStrategy: FeeStrategy;
  description?: string;
};

export type SignedCreateIntent = {
  issuer: string;
  signature: string;
  nonce: string;
  intent: Omit<SendIntent, "amount"> & { amount: string };
};

export type ApprovalIntent = {
  type: "approval";
  kind: "exec";
  title: string;
  command: string;
  workdir?: string;
  description?: string;
  agentId?: string;
  sessionKey?: string;
  toolCallId?: string;
};

export type SignedCreateApprovalIntent = {
  issuer: string;
  signature: string;
  nonce: string;
  intent: ApprovalIntent;
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

export function encodeSendIntentTlv(intent: SendIntent, nonce: string): Uint8Array {
  const sender = evmAddress(intent.sender, "sender");
  const recipient = evmAddress(intent.recipient, "recipient");
  const amount = unsignedMinimal(normalizeAmount(intent.amount));
  const asset = encodeAsset(intent.asset);
  const description =
    intent.description === undefined
      ? new Uint8Array()
      : tlv(0x16, utf8(assertDescription(intent.description)));
  if (intent.network !== "ethereum") {
    throw new AgentIntentSdkError(`unsupported network "${String(intent.network)}".`);
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
  const normalizedIntent = {
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
  const tlvBytes = encodeSendIntentTlv(intent, nonce);
  return {
    issuer: identity.publicKey,
    signature: bytesToHex(identity.signDigest(sha256Digest(tlvBytes), SIGNATURE_DER)),
    nonce,
    intent: normalizedIntent,
  };
}

export function encodeApprovalIntentTlv(intent: ApprovalIntent, nonce: string): Uint8Array {
  if (intent.kind !== "exec") {
    throw new AgentIntentSdkError(`unsupported approval kind "${String(intent.kind)}".`);
  }
  const payload = concatBytes(
    tlv(0x30, utf8(intent.kind)),
    tlv(0x31, utf8(assertLength(intent.title, "title", 80))),
    tlv(0x32, utf8(assertLength(intent.command, "command", 8192))),
    optionalText(0x33, intent.workdir, "workdir", 4096),
    intent.description === undefined
      ? new Uint8Array()
      : tlv(0x34, utf8(assertDescription(intent.description))),
    optionalText(0x35, intent.agentId, "agentId", 256),
    optionalText(0x36, intent.sessionKey, "sessionKey", 512),
    optionalText(0x37, intent.toolCallId, "toolCallId", 256),
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

export function signCreateApprovalIntent(
  identity: AgentIdentity,
  intent: ApprovalIntent,
  nonce = createNonce(),
): SignedCreateApprovalIntent {
  const tlvBytes = encodeApprovalIntentTlv(intent, nonce);
  return {
    issuer: identity.publicKey,
    signature: bytesToHex(identity.signDigest(sha256Digest(tlvBytes), SIGNATURE_DER)),
    nonce,
    intent,
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

function assertLength(value: string, label: string, max: number): string {
  const length = Array.from(value).length;
  if (length < 1 || length > max) {
    throw new AgentIntentSdkError(`${label} must contain between 1 and ${max} characters.`);
  }
  return value;
}

function optionalText(tag: number, value: string | undefined, label: string, max: number) {
  return value === undefined ? new Uint8Array() : tlv(tag, utf8(assertLength(value, label, max)));
}

function utf8(value: string): Uint8Array {
  return textEncoder.encode(value.normalize("NFC"));
}

function defaultRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
