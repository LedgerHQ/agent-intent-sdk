import { AgentIntentSdkError } from "./bytes.ts";

export const AGENT_INTENT_STATUSES = [
  "created",
  "crafted",
  "signed",
  "broadcast",
  "success",
  "failed",
  "rejected",
  "cancelled",
  "expired",
] as const;

export type AgentIntentStatus = (typeof AGENT_INTENT_STATUSES)[number];

export const AGENT_INTENT_PAGE_SIZES = [1, 5, 10, 50, 100] as const;

export type AgentIntentPageSize = (typeof AGENT_INTENT_PAGE_SIZES)[number];

export function isAgentIntentStatus(value: unknown): value is AgentIntentStatus {
  return (AGENT_INTENT_STATUSES as readonly unknown[]).includes(value);
}

export function isAgentIntentPageSize(value: unknown): value is AgentIntentPageSize {
  return (AGENT_INTENT_PAGE_SIZES as readonly unknown[]).includes(value);
}

/** Fields depend on `type` and a newer BFF may add some, so only `type` is guaranteed. */
export type AgentIntentOperation = {
  type: string;
  network?: string;
  sender?: string;
  recipient?: string;
  amount?: string;
  asset?: { type: string; assetReference?: string; assetOwner?: string };
  feeStrategy?: string;
  description?: string;
  [field: string]: unknown;
};

/** `status` stays open so that a state a newer BFF adds never breaks parsing. */
export type AgentIntentRecord = {
  id: string;
  agentPubkey: string;
  status: AgentIntentStatus | (string & {});
  intent: AgentIntentOperation;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
};

export type ListAgentIntentsQuery = {
  status?: readonly AgentIntentStatus[];
  pageSize?: AgentIntentPageSize;
  /** A page's `nextCursor`; when set, the first page's `status` and `pageSize` apply. */
  cursor?: string;
};

export type AgentIntentPage = {
  intents: AgentIntentRecord[];
  nextCursor?: string;
};

const OPTIONAL_STRING_FIELDS = [
  "network",
  "sender",
  "recipient",
  "amount",
  "fromAmount",
  "toAmount",
  "feeStrategy",
  "description",
] as const;

export function parseAgentIntentPage(body: string, nextCursor: string | null): AgentIntentPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new AgentIntentSdkError("BFF returned an intent listing that is not valid JSON.", {
      cause,
    });
  }
  if (!Array.isArray(parsed) || !parsed.every(isAgentIntentRecord)) {
    throw new AgentIntentSdkError("BFF returned an intent listing with an unexpected shape.");
  }
  return nextCursor ? { intents: parsed, nextCursor } : { intents: parsed };
}

function isAgentIntentRecord(value: unknown): value is AgentIntentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const intent = record.intent as Record<string, unknown> | null | undefined;
  return (
    typeof record.id === "string" &&
    typeof record.agentPubkey === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.failureReason === undefined || typeof record.failureReason === "string") &&
    typeof intent === "object" &&
    intent !== null &&
    typeof intent.type === "string" &&
    OPTIONAL_STRING_FIELDS.every((field) => isOptionalString(intent[field])) &&
    isOptionalAsset(intent.asset)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalAsset(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.type === "string" &&
    isOptionalString(asset.assetReference) &&
    isOptionalString(asset.assetOwner)
  );
}
