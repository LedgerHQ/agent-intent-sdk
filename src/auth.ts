import { AgentIntentSdkError, bytesToHex, concatBytes, hexToBytes } from "./bytes.ts";
import { SIGNATURE_DER, sha256Digest, type AgentIdentity } from "./identity.ts";

export type AgentIntentEnvironment = "staging" | "production";

export type AgentKeycloakConfig = {
  baseUrl: string;
  realm: string;
  clientId: string;
  brokerId: string;
  disablePkce?: boolean;
};

export const AGENT_KEYCLOAK_ENVIRONMENTS = {
  staging: {
    baseUrl: "https://global.api.stg.ledger-test.com/keycloak",
    realm: "agent-intent-customers",
    clientId: "agentic-client",
    brokerId: "lkrp",
  },
  production: {
    baseUrl: "https://global.api.prd.ledger.com/keycloak",
    realm: "agent-intent-customers",
    clientId: "agentic-client",
    brokerId: "lkrp",
  },
} as const satisfies Record<AgentIntentEnvironment, AgentKeycloakConfig>;

export type AccessTokenProvider = {
  withAccessToken<T>(
    query: (accessToken: string) => Promise<T>,
    retryWhen?: (result: T) => boolean,
  ): Promise<T>;
};

type LKRPChallenge = {
  tlv: string;
  json: { host: string } & Record<string, unknown>;
};

export function createAgentTokenProvider(input: {
  identity: AgentIdentity;
  trustchainId: string;
  keycloak: AgentKeycloakConfig;
  fetch?: typeof globalThis.fetch;
}): AccessTokenProvider {
  const fetcher = withNodeCookieJar(input.fetch ?? globalThis.fetch);
  let token: Promise<{ accessToken: string; expiresAt?: number }> | undefined;

  const acquire = async (force = false) => {
    if (force) token = undefined;
    if (token) {
      const cached = await token;
      if (cached.expiresAt === undefined || cached.expiresAt - 30_000 > Date.now()) return cached;
      token = undefined;
    }
    const pending = authenticateAgent(input.identity, input.trustchainId, input.keycloak, fetcher);
    const retained = pending.catch((cause: unknown) => {
      if (token === retained) token = undefined;
      throw cause;
    });
    token = retained;
    return token;
  };

  return {
    withAccessToken: async (query, retryWhen) => {
      const current = await acquire();
      const result = await query(current.accessToken);
      if (!retryWhen?.(result)) return result;
      return query((await acquire(true)).accessToken);
    },
  };
}

async function authenticateAgent(
  identity: AgentIdentity,
  trustchainId: string,
  keycloak: AgentKeycloakConfig,
  fetcher: typeof globalThis.fetch,
): Promise<{ accessToken: string; expiresAt?: number }> {
  const realmBaseUrl = `${keycloak.baseUrl.replace(/\/+$/, "")}/realms/${keycloak.realm}`;
  const redirectUri = `${realmBaseUrl}/broker/${keycloak.brokerId}/endpoint`;
  const pkce = keycloak.disablePkce ? undefined : await createPkcePair();
  const challengeUrl = new URL(`${realmBaseUrl}/protocol/openid-connect/auth`);
  challengeUrl.searchParams.set("response_type", "code");
  challengeUrl.searchParams.set("client_id", keycloak.clientId);
  challengeUrl.searchParams.set("scope", "openid");
  challengeUrl.searchParams.set("redirect_uri", redirectUri);
  if (pkce) {
    challengeUrl.searchParams.set("code_challenge", pkce.codeChallenge);
    challengeUrl.searchParams.set("code_challenge_method", "S256");
  }

  const challenge = asChallenge(
    await requestJson(
      "keycloak-challenge",
      challengeUrl.toString(),
      { headers: { Accept: "application/json" }, credentials: "include" },
      fetcher,
    ),
  );
  const signature = bytesToHex(
    identity.signDigest(sha256Digest(buildUnsignedChallengeTlv(challenge.tlv)), SIGNATURE_DER),
  );
  const authorizationCode = await requestJson(
    "oidc-authenticate",
    `https://${challenge.json.host}/openid/v1/authenticate`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        challenge: challenge.json,
        signature: {
          attestation: buildAttestation(trustchainId),
          credential: {
            version: 0,
            curveId: 33,
            signAlgorithm: 1,
            publicKey: identity.publicKey,
          },
          signature,
        },
      }),
    },
    fetcher,
  );
  if (typeof authorizationCode !== "string") {
    throw new AgentIntentSdkError("LKRP authentication returned no authorization code.");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    client_id: keycloak.clientId,
    redirect_uri: redirectUri,
  });
  if (pkce) form.set("code_verifier", pkce.codeVerifier);
  const idpTokenResponse = await requestJson(
    "oidc-token",
    `https://${challenge.json.host}/openid/v1/token`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      credentials: "include",
      body: form.toString(),
    },
    fetcher,
  );
  const idpToken = record(idpTokenResponse).access_token;
  if (typeof idpToken !== "string") {
    throw new AgentIntentSdkError("LKRP token exchange returned no access token.");
  }

  const exchanged = record(
    await requestJson(
      "oidc-exchange",
      `https://${challenge.json.host}/openid/v1/exchange`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${idpToken}`,
        },
        body: JSON.stringify({ client_id: keycloak.clientId }),
      },
      fetcher,
    ),
  );
  if (typeof exchanged.access_token !== "string") {
    throw new AgentIntentSdkError("Keycloak exchange returned no access token.");
  }
  const expiresIn = typeof exchanged.expires_in === "number" ? exchanged.expires_in : undefined;
  return {
    accessToken: exchanged.access_token,
    ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn * 1000 }),
  };
}

async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return { codeVerifier, codeChallenge: base64Url(new Uint8Array(digest)) };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildUnsignedChallengeTlv(tlvHex: string): Uint8Array {
  const fields = parseTlv(hexToBytes(tlvHex, "challenge TLV"));
  const required = [0x01, 0x02, 0x12, 0x14, 0x15, 0x16, 0x20, 0x32, 0x33, 0x60];
  if (fields.size > required.length) {
    throw new AgentIntentSdkError("challenge TLV contains unexpected data.");
  }
  for (const tag of required) {
    if (!fields.has(tag)) {
      throw new AgentIntentSdkError(`challenge TLV is missing field 0x${tag.toString(16)}.`);
    }
  }
  return concatBytes(
    ...[0x01, 0x02, 0x12, 0x16, 0x20, 0x60].map((tag) => {
      const value = fields.get(tag);
      if (value === undefined)
        throw new AgentIntentSdkError("challenge TLV changed while signing.");
      return Uint8Array.of(tag, value.length, ...value);
    }),
  );
}

export function buildAttestation(trustchainId: string): string {
  const id = new TextEncoder().encode(trustchainId);
  if (id.length > 255) throw new AgentIntentSdkError("trustchain ID is too long.");
  return bytesToHex(Uint8Array.of(0x02, id.length, ...id));
}

function parseTlv(bytes: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    if (tag === undefined || length === undefined || offset + 2 + length > bytes.length) {
      throw new AgentIntentSdkError("challenge TLV is truncated.");
    }
    fields.set(tag, bytes.slice(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return fields;
}

function asChallenge(value: unknown): LKRPChallenge {
  const candidate = value as Partial<LKRPChallenge> | null;
  const host = candidate?.json?.host;
  if (
    candidate === null ||
    typeof candidate?.tlv !== "string" ||
    typeof candidate.json !== "object" ||
    typeof host !== "string" ||
    !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host)
  ) {
    throw new AgentIntentSdkError("Keycloak returned a malformed LKRP challenge.");
  }
  return candidate as LKRPChallenge;
}

async function requestJson(
  leg: string,
  url: string,
  init: RequestInit,
  fetcher: typeof globalThis.fetch,
): Promise<unknown> {
  const response = await fetcher(url, init);
  const body = await response.text();
  if (!response.ok) {
    const detail = authenticationErrorDetail(body);
    throw new AgentIntentSdkError(
      `${leg} authentication request failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new AgentIntentSdkError("authentication request returned malformed JSON.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt?: number;
};

function withNodeCookieJar(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  const nodeProcess = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (!nodeProcess?.versions?.node) return fetcher;

  const cookies = new Map<string, StoredCookie>();
  return async (input, initialInit) => {
    let url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : input.url,
    );
    let init = initialInit ?? {};

    for (let redirects = 0; redirects <= 10; redirects += 1) {
      const headers = new Headers(init.headers);
      headers.delete("cookie");
      if (init.credentials !== "omit") {
        const cookieHeader = cookiesForUrl(cookies, url);
        if (cookieHeader) headers.set("cookie", cookieHeader);
      }

      const response = await fetcher(url, { ...init, headers, redirect: "manual" });
      storeResponseCookies(cookies, url, getSetCookieValues(response.headers));
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects === 10) {
        throw new AgentIntentSdkError("authentication request exceeded 10 redirects.");
      }

      const nextUrl = new URL(location, url);
      const nextHeaders = new Headers(init.headers);
      if (nextUrl.origin !== url.origin) nextHeaders.delete("authorization");
      const method = (init.method ?? "GET").toUpperCase();
      const switchToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST");
      if (switchToGet) {
        nextHeaders.delete("content-length");
        nextHeaders.delete("content-type");
        init = { ...init, method: "GET", body: undefined, headers: nextHeaders };
      } else {
        init = { ...init, headers: nextHeaders };
      }
      url = nextUrl;
    }

    throw new AgentIntentSdkError("authentication request exceeded 10 redirects.");
  };
}

function storeResponseCookies(
  cookies: Map<string, StoredCookie>,
  responseUrl: URL,
  values: string[],
): void {
  for (const value of values) {
    const parsed = parseSetCookie(value, responseUrl);
    if (!parsed) continue;
    const key = cookieKey(parsed);
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now()) cookies.delete(key);
    else cookies.set(key, parsed);
  }
}

function getSetCookieValues(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (values.length > 0) return values;
  }
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function parseSetCookie(value: string, responseUrl: URL): StoredCookie | undefined {
  const [pair, ...attributes] = value.split(";");
  if (pair === undefined) return undefined;
  const separator = pair.indexOf("=");
  if (separator <= 0) return undefined;

  const name = pair.slice(0, separator).trim();
  const cookieValue = pair.slice(separator + 1).trim();
  let domain = responseUrl.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultCookiePath(responseUrl.pathname);
  let secure = false;
  let expiresAt: number | undefined;

  for (const attribute of attributes) {
    const [rawName, ...rawValue] = attribute.trim().split("=");
    const attributeName = rawName?.toLowerCase();
    const attributeValue = rawValue.join("=");
    if (attributeName === "domain") {
      const candidate = attributeValue.toLowerCase().replace(/^\./, "");
      if (
        !candidate ||
        (responseUrl.hostname.toLowerCase() !== candidate &&
          !responseUrl.hostname.toLowerCase().endsWith(`.${candidate}`))
      ) {
        return undefined;
      }
      domain = candidate;
      hostOnly = false;
    } else if (attributeName === "path" && attributeValue.startsWith("/")) {
      path = attributeValue;
    } else if (attributeName === "secure") {
      secure = true;
    } else if (attributeName === "max-age") {
      const seconds = Number(attributeValue);
      if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
    } else if (attributeName === "expires" && expiresAt === undefined) {
      const timestamp = Date.parse(attributeValue);
      if (!Number.isNaN(timestamp)) expiresAt = timestamp;
    }
  }

  return { name, value: cookieValue, domain, hostOnly, path, secure, expiresAt };
}

function cookiesForUrl(cookies: Map<string, StoredCookie>, url: URL): string {
  const now = Date.now();
  const hostname = url.hostname.toLowerCase();
  const matches: StoredCookie[] = [];
  for (const [key, cookie] of cookies) {
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
      cookies.delete(key);
      continue;
    }
    const domainMatches =
      hostname === cookie.domain || (!cookie.hostOnly && hostname.endsWith(`.${cookie.domain}`));
    if (
      domainMatches &&
      cookiePathMatches(url.pathname, cookie.path) &&
      (!cookie.secure || url.protocol === "https:")
    ) {
      matches.push(cookie);
    }
  }
  return matches
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookiePathMatches(pathname: string, cookiePath: string): boolean {
  return (
    pathname === cookiePath ||
    (pathname.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") || pathname[cookiePath.length] === "/"))
  );
}

function cookieKey(cookie: StoredCookie): string {
  return `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
}

function authenticationErrorDetail(body: string): string {
  let detail = body;
  try {
    const parsed = record(JSON.parse(body));
    detail =
      [parsed.error_description, parsed.error, parsed.message].find(
        (value): value is string => typeof value === "string",
      ) ?? body;
  } catch {
    // Use the plain response body.
  }
  return detail
    .replace(/[A-Za-z0-9_-]{80,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}
