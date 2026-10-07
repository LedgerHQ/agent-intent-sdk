import { AgentIntentSdkError } from "./bytes.ts";

/** Lifecycle states the BFF reports for an intent. */
export const AGENT_INTENT_STATUSES = [
  "created",
  "crafted",
  "signed",
  "broadcast",
  "success",
  "failed",
  "rejected",
  "expired",
] as const;

export type AgentIntentStatus = (typeof AGENT_INTENT_STATUSES)[number];

/** Page sizes the BFF accepts for intent listings. */
export const AGENT_INTENT_PAGE_SIZES = [1, 5, 10, 50, 100] as const;

export type AgentIntentPageSize = (typeof AGENT_INTENT_PAGE_SIZES)[number];

export function isAgentIntentStatus(value: unknown): value is AgentIntentStatus {
  return (AGENT_INTENT_STATUSES as readonly unknown[]).includes(value);
}

export function isAgentIntentPageSize(value: unknown): value is AgentIntentPageSize {
  return (AGENT_INTENT_PAGE_SIZES as readonly unknown[]).includes(value);
}

/**
 * The operation an intent proposes, as the BFF returns it. Amounts (`amount`, and `fromAmount` /
 * `toAmount` for swaps) are always exact decimal strings of base units. Fields depend on `type`, and
 * a newer BFF may add some, so only `type` is guaranteed.
 */
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

/** One intent from an agent's listing. `status` is a string so a newer BFF state never breaks parsing. */
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
  /** Keep only intents in one of these states. Ignored when `cursor` is set. */
  status?: readonly AgentIntentStatus[];
  /** Ignored when `cursor` is set: the cursor keeps the first page's size. */
  pageSize?: AgentIntentPageSize;
  /** Opaque continuation token from a previous page's `nextCursor`. */
  cursor?: string;
};

export type AgentIntentPage = {
  /** Most recent first. */
  intents: AgentIntentRecord[];
  /** Pass back as `cursor` to fetch the next page; absent on the last page. */
  nextCursor?: string;
};

// Only valid JSON integers: a malformed number such as `01` is left for `JSON.parse` to reject.
const AMOUNT_NUMBER = /("(?:amount|fromAmount|toAmount)"\s*:\s*)(0|[1-9]\d*)(?=\s*[,}])/g;

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

/**
 * Parses an intent listing body. An older BFF encodes amounts as JSON numbers; they are turned into
 * strings before `JSON.parse` so amounts above 2^53 keep every digit.
 */
export function parseAgentIntentPage(body: string, nextCursor: string | null): AgentIntentPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(AMOUNT_NUMBER, '$1"$2"'));
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
