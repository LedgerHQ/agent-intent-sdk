import { AgentIntentSdkError } from "./bytes.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGITS = new Map(Array.from(ALPHABET, (character, index) => [character, index]));

/** Bitcoin-alphabet base58, as Solana writes addresses. */
export function base58Decode(value: string, label = "value"): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const digit = DIGITS.get(character);
    if (digit === undefined) throw new AgentIntentSdkError(`${label} must be base58.`);
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index]! * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    for (; carry > 0; carry >>= 8) bytes.push(carry & 0xff);
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index]! << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    for (; carry > 0; carry = Math.floor(carry / 58)) digits.push(carry % 58);
  }
  let leadingZeros = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += "1";
  }
  return (
    leadingZeros +
    digits
      .reverse()
      .map((digit) => ALPHABET[digit])
      .join("")
  );
}
