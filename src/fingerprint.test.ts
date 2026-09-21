import { describe, expect, it } from "vitest";
import { formatAgentPublicKeyFingerprint } from "./fingerprint.ts";

const UNCOMPRESSED_PUBLIC_KEY =
  "04a9b27632241403a440bf739910c77e84f34060d33e9499b546b93c10130baeaa" +
  "36d91a53e7400d3f6eca183c8325e846c0c37911b17f56f1439d636a0e55afe2";
const COMPRESSED_PUBLIC_KEY = "02a9b27632241403a440bf739910c77e84f34060d33e9499b546b93c10130baeaa";

describe("agent public key fingerprint", () => {
  it("matches the fingerprint display ADR", () => {
    expect(formatAgentPublicKeyFingerprint(UNCOMPRESSED_PUBLIC_KEY)).toBe("6jT9 eRxs owF1 FP");
  });

  it("normalizes compressed and uncompressed public keys", () => {
    expect(formatAgentPublicKeyFingerprint(COMPRESSED_PUBLIC_KEY)).toBe(
      formatAgentPublicKeyFingerprint(UNCOMPRESSED_PUBLIC_KEY),
    );
  });

  it("rejects an invalid secp256k1 public key", () => {
    expect(() => formatAgentPublicKeyFingerprint("04deadbeef")).toThrow(
      /valid compressed or uncompressed secp256k1 public key/,
    );
  });
});
