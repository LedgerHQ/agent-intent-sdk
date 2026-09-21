import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { AgentIntentSdkError, hexToBytes } from "./bytes.ts";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FINGERPRINT_BYTES = 10;
const DISPLAY_GROUP_SIZE = 4;

export function formatAgentPublicKeyFingerprint(publicKey: string | Uint8Array): string {
  const encodedKey =
    typeof publicKey === "string" ? hexToBytes(publicKey, "public key") : publicKey.slice();

  let compressedKey: Uint8Array;
  try {
    compressedKey = secp256k1.Point.fromBytes(encodedKey).toBytes(true);
  } catch {
    throw new AgentIntentSdkError(
      "public key must be a valid compressed or uncompressed secp256k1 public key.",
    );
  }

  const fingerprint = sha256(compressedKey).slice(0, FINGERPRINT_BYTES);
  const base58 = encodeBase58(fingerprint);
  return base58.match(new RegExp(`.{1,${DISPLAY_GROUP_SIZE}}`, "g"))?.join(" ") ?? "";
}

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = BASE58_ALPHABET[0] + encoded;
  }
  return encoded;
}
