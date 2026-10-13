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

export type AgentIntentAsset = { type: string; assetReference?: string; assetOwner?: string };

/**
 * An EVM send has a `feeStrategy`, a Solana send may have a `memo`; tell them apart by `network`.
 * `amount` is an integer string in the asset's smallest unit (wei, lamports, token base units),
 * unlike a swap's human-unit decimal amounts.
 */
export type AgentIntentSendOperation = {
  type: "send";
  network: string;
  sender: string;
  recipient: string;
  amount: string;
  asset: AgentIntentAsset;
  feeStrategy?: string;
  memo?: string;
  description?: string;
};

/** Amounts are in the assets' human units, as the agent signed them. */
export type AgentIntentSwapOperation = {
  type: "swap";
  network: string;
  sender: string;
  fromAsset: string;
  toAsset: string;
  fromAmount: string;
  toAmount: string;
  provider: string;
  description?: string;
};

/** An intent type this SDK version doesn't know yet. */
export type AgentIntentUnknownOperation = { type: string; [field: string]: unknown };

/** Narrow with `isSendOperation` or `isSwapOperation`: the open variant stops `type` from narrowing. */
export type AgentIntentOperation =
  | AgentIntentSendOperation
  | AgentIntentSwapOperation
  | AgentIntentUnknownOperation;

export function isSendOperation(
  operation: AgentIntentOperation,
): operation is AgentIntentSendOperation {
  return operation.type === "send" && hasKnownFields(operation);
}

export function isSwapOperation(
  operation: AgentIntentOperation,
): operation is AgentIntentSwapOperation {
  return operation.type === "swap" && hasKnownFields(operation);
}

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

// The BFF drops null fields, so a `null` optional field means a contract change: reject it.
const OPERATION_FIELDS = new Map<string, { required: string[]; optional: string[] }>([
  [
    "send",
    {
      required: ["network", "sender", "recipient", "amount"],
      optional: ["feeStrategy", "memo", "description"],
    },
  ],
  [
    "swap",
    {
      required: ["network", "sender", "fromAsset", "toAsset", "fromAmount", "toAmount", "provider"],
      optional: ["description"],
    },
  ],
]);

export function parseAgentIntentPage(body: string, nextCursor: string | null): AgentIntentPage {
  const parsed = parseJson(body, "an intent listing");
  if (!Array.isArray(parsed) || !parsed.every(isAgentIntentRecord)) {
    throw new AgentIntentSdkError("BFF returned an intent listing with an unexpected shape.");
  }
  return nextCursor ? { intents: parsed, nextCursor } : { intents: parsed };
}

export function parseAgentIntentRecord(body: string): AgentIntentRecord {
  const parsed = parseJson(body, "an intent");
  if (!isAgentIntentRecord(parsed)) {
    throw new AgentIntentSdkError("BFF returned an intent with an unexpected shape.");
  }
  return parsed;
}

function parseJson(body: string, subject: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new AgentIntentSdkError(`BFF returned ${subject} that is not valid JSON.`, { cause });
  }
}

function isAgentIntentRecord(value: unknown): value is AgentIntentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.agentPubkey === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.failureReason === undefined || typeof record.failureReason === "string") &&
    isOperation(record.intent)
  );
}

function isOperation(value: unknown): value is AgentIntentOperation {
  if (typeof value !== "object" || value === null) return false;
  const operation = value as Record<string, unknown>;
  return typeof operation.type === "string" && hasKnownFields(operation);
}

/** True for a type this SDK doesn't know; for a send or swap, checks its fields. */
function hasKnownFields(operation: Record<string, unknown>): boolean {
  const fields = OPERATION_FIELDS.get(String(operation.type));
  if (!fields) return true;
  return (
    fields.required.every((field) => typeof operation[field] === "string") &&
    fields.optional.every((field) => isOptionalString(operation[field])) &&
    (operation.type !== "send" || isAsset(operation.asset))
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isAsset(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.type === "string" &&
    isOptionalString(asset.assetReference) &&
    isOptionalString(asset.assetOwner)
  );
}
