import type { AccessTokenProvider } from "./auth.ts";
import {
  AgentIntentHttpError,
  httpError,
  intentListUrl,
  intentUrl,
  pathSegmentUrl,
  withTrailingSlash,
} from "./bffHttp.ts";
import { AgentIntentSdkError } from "./bytes.ts";
import {
  parseAgentIntentPage,
  parseAgentIntentRecord,
  type AgentIntentPage,
  type AgentIntentRecord,
  type ListAgentIntentsQuery,
} from "./intentPage.ts";
import { isNonEmptyString, isRecord, parseJson } from "./json.ts";

export const AGENT_INTENT_ERROR_TYPES = [
  "ambiguous_trustchain",
  "broadcast_rejected",
  "duplicate_event",
  "illegal_transition",
  "malformed_intent",
  "invalid_craft_parameters",
  "nonce_reused",
  "not_a_member",
  "pubkey_mismatch",
  "signature_invalid",
  "signature_malformed",
  "stale_revision",
  "token_expired",
  "token_invalid",
  "unexpected_caller",
  "unknown",
  "wrong_client_type",
] as const;

export type AgentIntentErrorType = (typeof AGENT_INTENT_ERROR_TYPES)[number];

export function isAgentIntentErrorType(value: unknown): value is AgentIntentErrorType {
  return (AGENT_INTENT_ERROR_TYPES as readonly unknown[]).includes(value);
}

export function isStaleRevisionError(
  error: unknown,
): error is AgentIntentHttpError & { readonly status: 409; readonly type: "stale_revision" } {
  return (
    error instanceof AgentIntentHttpError && error.status === 409 && error.type === "stale_revision"
  );
}

export type ListReviewerIntentsQuery = ListAgentIntentsQuery & { agentPubkey?: string };

export type AgentIntentStats = { total: number; approved: number; rejected: number };

export type AgentIntentSwapCraftParameters = {
  recipient: string;
  data: string;
  /** The native value the call carries, in the smallest unit. */
  amount: bigint;
  gasLimit: bigint;
};

export type AgentIntentCraft = {
  /** The unsigned transaction to sign as it is: 0x-hex on EVM, a base64 wire transaction on Solana. */
  rawTransaction: string;
  revision: number;
  details?: Record<string, unknown>;
};

export type AgentIntentSignatureSubmission = {
  /** EVM: `0x` + r‖s‖v (65 bytes, v 27 or 28). Solana: the 64-byte signature as hex, without `0x`. */
  signature: string;
  revision: number;
};

export type AgentIntentSignatureReceipt = { transactionId: string };

export type AgentProfileFields = {
  name: string;
  description: string;
  source: string;
  iconRef?: string;
};

export type AgentProfileUpdate = Partial<AgentProfileFields>;

export type AgentProfileRecord = {
  agentPubkey: string;
  profile: AgentProfileFields;
  createdAt: string;
  updatedAt: string;
};

export type AgentIntentReviewerClient = {
  listIntents(query?: ListReviewerIntentsQuery): Promise<AgentIntentPage>;
  getIntent(intentId: string): Promise<AgentIntentRecord>;
  getIntentStats(query?: { agentPubkey?: string }): Promise<AgentIntentStats>;
  craftIntent(intentId: string, swap?: AgentIntentSwapCraftParameters): Promise<AgentIntentCraft>;
  submitSignature(
    intentId: string,
    submission: AgentIntentSignatureSubmission,
  ): Promise<AgentIntentSignatureReceipt>;
  rejectIntent(intentId: string): Promise<void>;
  listAgentProfiles(): Promise<AgentProfileRecord[]>;
  getAgentProfile(agentPubkey: string): Promise<AgentProfileRecord | undefined>;
  createAgentProfile(agentPubkey: string, profile: AgentProfileFields): Promise<void>;
  updateAgentProfile(agentPubkey: string, update: AgentProfileUpdate): Promise<void>;
  deleteAgentProfile(agentPubkey: string): Promise<void>;
};

export function createAgentIntentReviewerClient(input: {
  bffBaseUrl: string;
  tokenProvider: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
}): AgentIntentReviewerClient {
  const fetcher = input.fetch ?? globalThis.fetch;
  const baseUrl = withTrailingSlash(input.bffBaseUrl);
  const intents = new URL("v1/intents", baseUrl);
  const profiles = new URL("v1/agent-profiles", baseUrl);

  const request = async (
    url: URL,
    method: string,
    jsonBody?: unknown,
  ): Promise<{ response: Response; body: string }> => {
    const response = await input.tokenProvider.withAccessToken(
      (accessToken) =>
        fetcher(url, {
          method,
          // Accept is also for the JSON error body of calls that answer without one.
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(jsonBody === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(jsonBody === undefined ? {} : { body: JSON.stringify(jsonBody) }),
        }),
      (candidate) => candidate.status === 401,
    );
    return { response, body: await response.text() };
  };

  const requestOk = async (url: URL, method: string, jsonBody?: unknown): Promise<string> => {
    const { response, body } = await request(url, method, jsonBody);
    if (!response.ok) throw httpError(response, body);
    return body;
  };

  const intentStep = (intentId: string, step: string): URL =>
    new URL(step, withTrailingSlash(intentUrl(intents, intentId).href));
  const profileUrl = (agentPubkey: string): URL =>
    pathSegmentUrl(profiles, agentPubkey, "agent public key");

  // Methods are async so that an invalid argument rejects the promise instead of throwing.
  return {
    listIntents: async (query = {}) => {
      const { response, body } = await request(intentListUrl(intents, query), "GET");
      if (!response.ok) throw httpError(response, body);
      return parseAgentIntentPage(body, response.headers.get("X-Ledger-Next"));
    },
    getIntent: async (intentId) =>
      parseAgentIntentRecord(await requestOk(intentUrl(intents, intentId), "GET")),
    getIntentStats: async (query = {}) => {
      if (query.agentPubkey === "") throw new AgentIntentSdkError("agentPubkey must not be empty.");
      const url = new URL("v1/intents/stats", baseUrl);
      if (query.agentPubkey !== undefined) url.searchParams.set("agentPubkey", query.agentPubkey);
      return parseStats(await requestOk(url, "GET"));
    },
    craftIntent: async (intentId, swap) => {
      const url = intentStep(intentId, "craft");
      return parseCraft(await requestOk(url, "POST", swap && swapCraftBody(swap)));
    },
    submitSignature: async (intentId, submission) => {
      if (typeof submission.signature !== "string" || submission.signature === "") {
        throw new AgentIntentSdkError("The signature must be a non-empty string.");
      }
      if (!Number.isSafeInteger(submission.revision) || submission.revision < 1) {
        throw new AgentIntentSdkError(`Invalid craft revision: ${String(submission.revision)}.`);
      }
      const url = intentStep(intentId, "signature");
      return parseReceipt(
        await requestOk(url, "POST", {
          signature: submission.signature,
          revision: submission.revision,
        }),
      );
    },
    rejectIntent: async (intentId) => {
      await requestOk(intentStep(intentId, "reject"), "POST");
    },
    listAgentProfiles: async () => parseProfiles(await requestOk(profiles, "GET")),
    getAgentProfile: async (agentPubkey) => {
      const { response, body } = await request(profileUrl(agentPubkey), "GET");
      if (response.status === 404 && isMissingProfileBody(body)) return undefined;
      if (!response.ok) throw httpError(response, body);
      return parseProfile(body);
    },
    createAgentProfile: async (agentPubkey, profile) => {
      await requestOk(profileUrl(agentPubkey), "POST", profile);
    },
    updateAgentProfile: async (agentPubkey, update) => {
      await requestOk(profileUrl(agentPubkey), "PATCH", update);
    },
    deleteAgentProfile: async (agentPubkey) => {
      await requestOk(profileUrl(agentPubkey), "DELETE");
    },
  };
}

function swapCraftBody(swap: AgentIntentSwapCraftParameters): Record<string, string> {
  if (!isNonEmptyString(swap.recipient) || !isNonEmptyString(swap.data)) {
    throw new AgentIntentSdkError("A swap craft needs the router address and its calldata.");
  }
  if (typeof swap.amount !== "bigint" || swap.amount < 0n) {
    throw new AgentIntentSdkError("A swap craft amount must be a non-negative bigint.");
  }
  if (typeof swap.gasLimit !== "bigint" || swap.gasLimit <= 0n) {
    throw new AgentIntentSdkError("A swap craft gas limit must be a positive bigint.");
  }
  // Decimal strings, which the BFF reads like numbers: wei go past what a JSON number holds exactly.
  return {
    recipient: swap.recipient,
    data: swap.data,
    amount: swap.amount.toString(),
    gasLimit: swap.gasLimit.toString(),
  };
}

// The BFF's missing-profile 404 has no `type`: only its message tells it from a gateway's 404.
const MISSING_PROFILE_MESSAGE = "Agent profile not found.";

function isMissingProfileBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed.message === MISSING_PROFILE_MESSAGE;
  } catch {
    return false;
  }
}

function parseStats(body: string): AgentIntentStats {
  const stats = parseJson(body, "intent counts");
  if (!isAgentIntentStats(stats)) {
    throw new AgentIntentSdkError("BFF returned intent counts with an unexpected shape.");
  }
  return stats;
}

function parseCraft(body: string): AgentIntentCraft {
  const craft = parseJson(body, "a crafted transaction");
  if (!isAgentIntentCraft(craft)) {
    throw new AgentIntentSdkError("BFF returned a crafted transaction with an unexpected shape.");
  }
  return craft;
}

function parseReceipt(body: string): AgentIntentSignatureReceipt {
  const receipt = parseJson(body, "a signature receipt");
  if (!isRecord(receipt) || !isNonEmptyString(receipt.transactionId)) {
    throw new AgentIntentSdkError("BFF returned a signature receipt with an unexpected shape.");
  }
  return { transactionId: receipt.transactionId };
}

function isAgentIntentStats(value: unknown): value is AgentIntentStats {
  return (
    isRecord(value) && isCount(value.total) && isCount(value.approved) && isCount(value.rejected)
  );
}

const EVM_RAW_TRANSACTION = /^0x(?:[0-9a-fA-F]{2})+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isAgentIntentCraft(value: unknown): value is AgentIntentCraft {
  return (
    isRecord(value) &&
    isNonEmptyString(value.rawTransaction) &&
    // A Solana wire transaction in base64 can't start with "0x": its first byte would be 0xD3.
    (value.rawTransaction.startsWith("0x")
      ? EVM_RAW_TRANSACTION.test(value.rawTransaction)
      : BASE64.test(value.rawTransaction)) &&
    isCount(value.revision) &&
    value.revision >= 1 &&
    (value.details === undefined || isRecord(value.details))
  );
}

function parseProfiles(body: string): AgentProfileRecord[] {
  const profiles = parseJson(body, "agent profiles");
  if (!Array.isArray(profiles) || !profiles.every(isAgentProfileRecord)) {
    throw new AgentIntentSdkError("BFF returned agent profiles with an unexpected shape.");
  }
  return profiles;
}

function parseProfile(body: string): AgentProfileRecord {
  const profile = parseJson(body, "an agent profile");
  if (!isAgentProfileRecord(profile)) {
    throw new AgentIntentSdkError("BFF returned an agent profile with an unexpected shape.");
  }
  return profile;
}

function isAgentProfileRecord(value: unknown): value is AgentProfileRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agentPubkey) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isRecord(value.profile) &&
    typeof value.profile.name === "string" &&
    typeof value.profile.description === "string" &&
    typeof value.profile.source === "string" &&
    (value.profile.iconRef === undefined || typeof value.profile.iconRef === "string")
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
