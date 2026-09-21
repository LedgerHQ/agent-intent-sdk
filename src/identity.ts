import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { AgentIntentSdkError, bytesToHex, hexToBytes } from "./bytes.ts";

export const SIGNATURE_COMPACT = 0;
export const SIGNATURE_DER = 1;

export type AgentIdentity = {
  readonly publicKey: string;
  signDigest(
    digest: Uint8Array,
    format?: typeof SIGNATURE_COMPACT | typeof SIGNATURE_DER,
  ): Uint8Array;
  deriveSharedSecret(peerPublicKey: Uint8Array): Uint8Array;
};

export type SoftwareAgentIdentity = AgentIdentity & {
  exportSecretKey(): string;
};

export function createSoftwareAgentIdentity(
  secretKey?: string | Uint8Array,
): SoftwareAgentIdentity {
  const key =
    typeof secretKey === "string"
      ? hexToBytes(secretKey, "secret key")
      : (secretKey?.slice() ?? secp256k1.utils.randomSecretKey());
  if (!secp256k1.utils.isValidSecretKey(key)) {
    throw new AgentIntentSdkError("secret key is not a valid secp256k1 scalar.");
  }

  const publicKey = bytesToHex(secp256k1.getPublicKey(key, true));
  return {
    publicKey,
    signDigest: (digest, format = SIGNATURE_DER) =>
      secp256k1.sign(digest, key, {
        prehash: false,
        lowS: true,
        format: format === SIGNATURE_DER ? "der" : "compact",
      }),
    deriveSharedSecret: (peerPublicKey) =>
      secp256k1.getSharedSecret(key, peerPublicKey, true).slice(1),
    exportSecretKey: () => bytesToHex(key),
  };
}

export function sha256Digest(value: Uint8Array): Uint8Array {
  return sha256(value);
}
