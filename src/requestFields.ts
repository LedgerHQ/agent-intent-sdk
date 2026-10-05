import { secp256k1 } from "@noble/curves/secp256k1.js";

/** @internal Field validators shared by signed enrollment and recovery requests. */

const HEX = /^[0-9a-f]+$/i;

export function singleString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isPublicKey(value: string): boolean {
  return (value.length === 66 || value.length === 130) && HEX.test(value);
}

export function isCompressedPublicKey(value: string | undefined): value is string {
  if (value === undefined || value.length !== 66 || !HEX.test(value)) {
    return false;
  }
  try {
    secp256k1.Point.fromHex(value);
    return true;
  } catch {
    return false;
  }
}

export function isEnrollmentEnvironment(
  value: string | undefined,
): value is "staging" | "production" {
  return value === "staging" || value === "production";
}

export function isCompactSignature(value: string): boolean {
  return value.length === 128 && HEX.test(value);
}
