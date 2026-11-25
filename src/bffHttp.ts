import { AgentIntentSdkError } from "./bytes.ts";
import {
  isAgentIntentPageSize,
  isAgentIntentStatus,
  type ListAgentIntentsQuery,
} from "./intentPage.ts";

export class AgentIntentHttpError extends AgentIntentSdkError {
  readonly status: number;
  readonly type: string | undefined;

  constructor(message: string, status: number, type?: string) {
    super(message);
    this.name = "AgentIntentHttpError";
    this.status = status;
    this.type = type;
  }
}

export function httpError(response: Response, body: string): AgentIntentHttpError {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; type?: unknown };
    return new AgentIntentHttpError(
      typeof parsed.message === "string"
        ? parsed.message
        : `BFF request failed (${response.status}).`,
      response.status,
      typeof parsed.type === "string" ? parsed.type : undefined,
    );
  } catch {
    return new AgentIntentHttpError(
      body || `BFF request failed (${response.status}).`,
      response.status,
    );
  }
}

export function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function intentUrl(endpoint: URL, intentId: string): URL {
  return pathSegmentUrl(endpoint, intentId, "intent id");
}

export function pathSegmentUrl(endpoint: URL, segment: string, name: string): URL {
  // encodeURIComponent keeps "." and "..", which URL resolution would turn into another endpoint.
  if (segment === "" || segment === "." || segment === "..") {
    throw new AgentIntentSdkError(`Invalid ${name}: "${segment}".`);
  }
  return new URL(encodeURIComponent(segment), withTrailingSlash(endpoint.href));
}

export function intentListUrl(
  endpoint: URL,
  query: ListAgentIntentsQuery & { agentPubkey?: string },
): URL {
  const url = new URL(endpoint);
  // An empty cursor means "no next page", like an empty `X-Ledger-Next`.
  if (query.cursor) {
    url.searchParams.set("cursor", query.cursor);
    return url;
  }
  // The types already restrict these; JavaScript callers get a clear error instead of a 400.
  const unknownStatus = query.status?.find((status) => !isAgentIntentStatus(status));
  if (unknownStatus !== undefined) {
    throw new AgentIntentSdkError(`Unsupported intent status: ${String(unknownStatus)}.`);
  }
  if (query.pageSize !== undefined && !isAgentIntentPageSize(query.pageSize)) {
    throw new AgentIntentSdkError(`Unsupported pageSize: ${String(query.pageSize)}.`);
  }
  if (query.agentPubkey === "") {
    throw new AgentIntentSdkError("agentPubkey must not be empty.");
  }
  if (query.status?.length) url.searchParams.set("status", query.status.join(","));
  if (query.pageSize !== undefined) url.searchParams.set("pageSize", String(query.pageSize));
  if (query.agentPubkey !== undefined) url.searchParams.set("agentPubkey", query.agentPubkey);
  return url;
}
