const SDK_PACKAGE = "@ledgerhq/agent-intent-sdk";

type NodeProcess = {
  versions?: { node?: string };
  getBuiltinModule?: (id: "node:module") => {
    createRequire(path: string | URL): (id: string) => unknown;
  };
};

/** The Node process (also Bun's, Deno 2's and Workers' with `nodejs_compat`), or `undefined` in a browser. */
export function nodeProcess(): NodeProcess | undefined {
  const candidate = (globalThis as { process?: NodeProcess }).process;
  return candidate?.versions?.node ? candidate : undefined;
}

/** Undefined in browsers: they send their own UA, and setting one would force a CORS preflight. */
export function agentUserAgent(): string | undefined {
  const node = nodeProcess();
  return node ? `ledger-agent-intent-sdk/${sdkVersion(node)} (agentic)` : undefined;
}

/** Adds the agent User-Agent unless the request already sets one. */
export function withAgentUserAgent(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  const userAgent = agentUserAgent();
  if (!userAgent) return fetcher;
  // `init.headers` replaces a Request's own headers, so start from them when init has none.
  // Checked by shape: a polyfilled or cross-realm Request isn't an `instanceof Request`.
  return (input, init) =>
    fetcher(input, {
      ...init,
      headers: withUserAgentHeader(
        init?.headers ??
          (typeof input === "object" && "headers" in input ? input.headers : undefined),
        userAgent,
      ),
    });
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

// Replaced in dist by scripts/stamp-version.mjs so the version survives bundling.
const BUILD_VERSION: string = "__SDK_VERSION__";

// `getBuiltinModule` keeps `node:module` out of browser bundles' import graph.
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
