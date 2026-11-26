import { AgentIntentSdkError } from "./bytes.ts";

export function parseJson(body: string, subject: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new AgentIntentSdkError(`BFF returned ${subject} that is not valid JSON.`, { cause });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
