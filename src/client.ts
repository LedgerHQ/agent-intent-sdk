import {
  AGENT_KEYCLOAK_ENVIRONMENTS,
  createAgentTokenProvider,
  type AccessTokenProvider,
  type AgentIntentEnvironment,
  type AgentKeycloakConfig,
} from "./auth.ts";
import { AgentIntentSdkError } from "./bytes.ts";
import type { AgentIdentity } from "./identity.ts";
import { withAgentUserAgent } from "./userAgent.ts";
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
  signSwapIntent,
  type SendIntent,
  type SignedCreateIntent,
  type SignedSwapIntent,
  type SwapIntent,
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
  getIntent(intentId: string): Promise<AgentIntentRecord>;
  createSwapIntent(intent: SwapIntent): Promise<string>;
  createSignedSwapIntent(intent: SwapIntent, nonce?: string): SignedSwapIntent;
  /**
   * Cancels an intent this agent issued, while it is `created` or `crafted`; it can't be undone.
   * Resolves once the intent is cancelled, also when it already was. Any other state throws
   * `AgentIntentHttpError` with status 400, and an unknown id or another agent's intent 404.
   */
  cancelIntent(intentId: string): Promise<void>;
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
  const baseFetch = input.fetch ?? globalThis.fetch;
  const fetcher = withAgentUserAgent(baseFetch);
  const tokenProvider =
    input.tokenProvider ??
    createAgentTokenProvider({
      identity: input.identity,
      trustchainId: input.trustchainId,
      keycloak: input.keycloak ?? AGENT_KEYCLOAK_ENVIRONMENTS[input.environment],
      fetch: input.authFetch ?? baseFetch,
    });
  const endpoint = new URL("v1/intents", withTrailingSlash(input.bffBaseUrl));

  const submitIntent = async (requestBody: string): Promise<string> => {
    const response = await tokenProvider.withAccessToken(
      (accessToken) =>
        fetcher(endpoint, {
          method: "POST",
          headers: {
            Accept: "text/plain",
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
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
  };

  return {
    publicKey: input.identity.publicKey,
    createSignedIntent: (intent, nonce) => signCreateIntent(input.identity, intent, nonce),
    // async so a validation error rejects the promise instead of throwing synchronously.
    createSendIntent: async (intent) =>
      submitIntent(serializeCreateIntent(signCreateIntent(input.identity, intent))),
    createSwapIntent: async (intent) =>
      submitIntent(JSON.stringify(signSwapIntent(input.identity, intent))),
    createSignedSwapIntent: (intent, nonce) => signSwapIntent(input.identity, intent, nonce),
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
      const url = intentUrl(endpoint, intentId);
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
    cancelIntent: async (intentId) => {
      const url = new URL("cancel", withTrailingSlash(intentUrl(endpoint, intentId).href));
      const response = await tokenProvider.withAccessToken(
        (accessToken) =>
          fetcher(url, {
            method: "POST",
            headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          }),
        (candidate) => candidate.status === 401,
      );
      const body = await response.text();
      if (!response.ok) throw httpError(response, body);
    },
  };
}

function intentUrl(endpoint: URL, intentId: string): URL {
  // encodeURIComponent keeps "." and "..", which URL resolution would turn into another endpoint.
  if (intentId === "" || intentId === "." || intentId === "..") {
    throw new AgentIntentSdkError(`Invalid intent id: "${intentId}".`);
  }
  return new URL(encodeURIComponent(intentId), withTrailingSlash(endpoint.href));
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
