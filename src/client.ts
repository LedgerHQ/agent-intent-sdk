import {
  AGENT_KEYCLOAK_ENVIRONMENTS,
  createAgentTokenProvider,
  type AccessTokenProvider,
  type AgentIntentEnvironment,
  type AgentKeycloakConfig,
} from "./auth.ts";
import { AgentIntentSdkError } from "./bytes.ts";
import type { AgentIdentity } from "./identity.ts";
import {
  isAgentIntentPageSize,
  isAgentIntentStatus,
  parseAgentIntentPage,
  parseAgentIntentRecord,
  type AgentIntentPage,
  type AgentIntentRecord,
  type ListAgentIntentsQuery,
} from "./intentPage.ts";
import {
  serializeCreateIntent,
  signCreateIntent,
  type SendIntent,
  type SignedCreateIntent,
} from "./intents.ts";

export const AGENT_INTENT_FRONTEND_URLS: Record<AgentIntentEnvironment, string> = {
  staging: "https://agent-intent.ledger-test.com/",
  production: "https://agent-intent.ledger.com/",
};

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

export type AgentIntentClient = {
  readonly publicKey: string;
  createSendIntent(intent: SendIntent): Promise<string>;
  createSignedIntent(intent: SendIntent, nonce?: string): SignedCreateIntent;
  listIntents(query?: ListAgentIntentsQuery): Promise<AgentIntentPage>;
  /**
   * Reads one intent this agent issued. The BFF answers 404, as `AgentIntentHttpError`, both for an
   * unknown id and for another agent's intent, so the two can't be told apart.
   */
  getIntent(intentId: string): Promise<AgentIntentRecord>;
};

export function createAgentIntentClient(input: {
  bffBaseUrl: string;
  identity: AgentIdentity;
  trustchainId: string;
  environment: AgentIntentEnvironment;
  keycloak?: AgentKeycloakConfig;
  tokenProvider?: AccessTokenProvider;
  fetch?: typeof globalThis.fetch;
  authFetch?: typeof globalThis.fetch;
}): AgentIntentClient {
  const fetcher = input.fetch ?? globalThis.fetch;
  const tokenProvider =
    input.tokenProvider ??
    createAgentTokenProvider({
      identity: input.identity,
      trustchainId: input.trustchainId,
      keycloak: input.keycloak ?? AGENT_KEYCLOAK_ENVIRONMENTS[input.environment],
      fetch: input.authFetch ?? fetcher,
    });
  const endpoint = new URL("v1/intents", withTrailingSlash(input.bffBaseUrl));

  return {
    publicKey: input.identity.publicKey,
    createSignedIntent: (intent, nonce) => signCreateIntent(input.identity, intent, nonce),
    createSendIntent: async (intent) => {
      const request = signCreateIntent(input.identity, intent);
      const response = await tokenProvider.withAccessToken(
        (accessToken) =>
          fetcher(endpoint, {
            method: "POST",
            headers: {
              Accept: "text/plain",
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: serializeCreateIntent(request),
          }),
        (candidate) => candidate.status === 401,
      );
      const body = await response.text();
      if (!response.ok) throw httpError(response, body);
      try {
        const deeplink = new URL(body);
        return new URL(
          `${deeplink.pathname}${deeplink.search}${deeplink.hash}`,
          AGENT_INTENT_FRONTEND_URLS[input.environment],
        ).toString();
      } catch {
        throw new AgentIntentSdkError("BFF returned an invalid intent deeplink.");
      }
    },
    listIntents: async (query = {}) => {
      const url = new URL(endpoint);
      // An empty cursor means "no next page", like an empty `X-Ledger-Next`.
      if (query.cursor) {
        url.searchParams.set("cursor", query.cursor);
      } else {
        // The types already restrict these; JavaScript callers get a clear error instead of a 400.
        const unknownStatus = query.status?.find((status) => !isAgentIntentStatus(status));
        if (unknownStatus !== undefined) {
          throw new AgentIntentSdkError(`Unsupported intent status: ${String(unknownStatus)}.`);
        }
        if (query.pageSize !== undefined && !isAgentIntentPageSize(query.pageSize)) {
          throw new AgentIntentSdkError(`Unsupported pageSize: ${String(query.pageSize)}.`);
        }
        if (query.status?.length) url.searchParams.set("status", query.status.join(","));
        if (query.pageSize !== undefined) url.searchParams.set("pageSize", String(query.pageSize));
      }
      const response = await tokenProvider.withAccessToken(
        (accessToken) =>
          fetcher(url, {
            method: "GET",
            headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          }),
        (candidate) => candidate.status === 401,
      );
      const body = await response.text();
      if (!response.ok) throw httpError(response, body);
      return parseAgentIntentPage(body, response.headers.get("X-Ledger-Next"));
    },
    getIntent: async (intentId) => {
      const url = new URL(encodeURIComponent(intentId), withTrailingSlash(endpoint.href));
      const response = await tokenProvider.withAccessToken(
        (accessToken) =>
          fetcher(url, {
            method: "GET",
            headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          }),
        (candidate) => candidate.status === 401,
      );
      const body = await response.text();
      if (!response.ok) throw httpError(response, body);
      return parseAgentIntentRecord(body);
    },
  };
}

export function staticAccessTokenProvider(accessToken: string): AccessTokenProvider {
  return {
    withAccessToken: (query) => query(accessToken),
  };
}

function httpError(response: Response, body: string): AgentIntentHttpError {
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

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
