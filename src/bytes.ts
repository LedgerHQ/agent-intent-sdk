export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value: string, label = "value"): Uint8Array {
  const hex = value.replace(/^0x/i, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new AgentIntentSdkError(`${label} must be an even-length hexadecimal string.`);
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export class AgentIntentSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentIntentSdkError";
  }
}
