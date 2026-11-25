import {
  AGENT_KEYCLOAK_ENVIRONMENTS,
  createAgentTokenProvider,
  type AccessTokenProvider,
  type AgentIntentEnvironment,
  type AgentKeycloakConfig,
} from "./auth.ts";
import { httpError, intentListUrl, intentUrl, withTrailingSlash } from "./bffHttp.ts";
import { AgentIntentSdkError } from "./bytes.ts";
import type { AgentIdentity } from "./identity.ts";
import { withAgentUserAgent } from "./userAgent.ts";
import {
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

export { AgentIntentHttpError } from "./bffHttp.ts";

export const AGENT_INTENT_FRONTEND_URLS: Record<AgentIntentEnvironment, string> = {
  staging: "https://app.agents.ledger-test.com/",
  production: "https://app.agents.ledger.com/",
};

export function buildAgentSetupPrompt(appUrl: string): string {
  return `Use the latest Ledger wallet-cli (npm package @ledgerhq/wallet-cli) and its agent skill with \`wallet-cli skill install --force\`, then follow the skill's Agent Intent section to enroll an agent with the app at ${promptAppUrl(appUrl)}.`;
}

function promptAppUrl(appUrl: string): string {
  const url = new URL(appUrl);
  if (url.protocol === "https:") return url.host;
  if (url.protocol === "http:") return url.origin;
  throw new AgentIntentSdkError(`The Agent Intent app URL must be http(s), got "${appUrl}".`);
}

export type AgentIntentClient = {
  readonly publicKey: string;
  createSendIntent(intent: SendIntent): Promise<string>;
  createSignedIntent(intent: SendIntent, nonce?: string): SignedCreateIntent;
  listIntents(query?: ListAgentIntentsQuery): Promise<AgentIntentPage>;
  getIntent(intentId: string): Promise<AgentIntentRecord>;
  createSwapIntent(intent: SwapIntent): Promise<string>;
  createSignedSwapIntent(intent: SwapIntent, nonce?: string): SignedSwapIntent;
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
      // Only the agent's own filters: an `agentPubkey` from a widened object is not one of them.
      const { status, pageSize, cursor } = query;
      const url = intentListUrl(endpoint, { status, pageSize, cursor });
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
            // The 204 has no body; Accept is for the JSON error body.
            headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
          }),
        (candidate) => candidate.status === 401,
      );
      const body = await response.text();
      if (!response.ok) throw httpError(response, body);
    },
  };
}

export function staticAccessTokenProvider(accessToken: string): AccessTokenProvider {
  return {
    withAccessToken: (query) => query(accessToken),
  };
}
