const SDK_PACKAGE = "@ledgerhq/agent-intent-sdk";

type NodeProcess = {
  versions?: { node?: string };
  getBuiltinModule?: (id: "node:module") => {
    createRequire(path: string | URL): (id: string) => unknown;
  };
};

/** The Node process (also Bun's), or `undefined` in a browser. */
export function nodeProcess(): NodeProcess | undefined {
  const candidate = (globalThis as { process?: NodeProcess }).process;
  return candidate?.versions?.node ? candidate : undefined;
}

/**
 * `ledger-agent-intent-sdk/<version> (agentic)`, so agent traffic to the BFF and Keycloak can be
 * monitored on its own in Cloudflare and Datadog. Only agents send it: in a browser the request
 * keeps the browser's own User-Agent, and setting one there would trigger a CORS preflight.
 */
export function agentUserAgent(): string | undefined {
  const node = nodeProcess();
  return node ? `ledger-agent-intent-sdk/${sdkVersion(node)} (agentic)` : undefined;
}

/**
 * Wraps the fetch the SDK sends its own requests with, so each one carries the agent User-Agent
 * unless its headers already set one. In a browser it returns `fetcher` unchanged.
 */
export function withAgentUserAgent(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  const userAgent = agentUserAgent();
  if (!userAgent) return fetcher;
  return (input, init) =>
    fetcher(input, { ...init, headers: withUserAgentHeader(init?.headers, userAgent) });
}

function withUserAgentHeader(headers: HeadersInit | undefined, userAgent: string): HeadersInit {
  if (headers instanceof Headers || Array.isArray(headers)) {
    const merged = new Headers(headers);
    if (!merged.has("user-agent")) merged.set("user-agent", userAgent);
    return merged;
  }
  const named = headers ?? {};
  return Object.keys(named).some((name) => name.toLowerCase() === "user-agent")
    ? named
    : { ...named, "User-Agent": userAgent };
}

// `scripts/stamp-version.mjs` writes the package version here in `dist`, so it survives bundling
// and single-file executables such as a compiled wallet-cli.
const BUILD_VERSION: string = "__SDK_VERSION__";

// From source (tests, local development), read the package's own manifest instead.
// `getBuiltinModule` keeps `node:module` out of the import graph that browser bundles follow.
function sdkVersion(node: NodeProcess): string {
  if (!BUILD_VERSION.startsWith("__")) return BUILD_VERSION;
  try {
    const require = node.getBuiltinModule?.("node:module").createRequire(import.meta.url);
    const manifest = require?.(`${SDK_PACKAGE}/package.json`) as { version?: unknown } | undefined;
    return typeof manifest?.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}
