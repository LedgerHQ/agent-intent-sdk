import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentUserAgent, withAgentUserAgent } from "./userAgent.ts";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const USER_AGENT = `ledger-agent-intent-sdk/${version} (agentic)`;

describe("agent User-Agent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the SDK, its published version and the agentic marker in Node", () => {
    expect(agentUserAgent()).toBe(USER_AGENT);
  });

  it("adds it to every request the wrapped fetch sends", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));

    await withAgentUserAgent(fetcher)("https://bff.example", {
      method: "POST",
      headers: { Accept: "application/json" },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("https://bff.example", {
      method: "POST",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
  });

  it.each([
    ["a header record", { "user-agent": "host/1.0" }],
    ["a Headers object", new Headers({ "User-Agent": "host/1.0" })],
  ])("keeps a User-Agent the request already sets in %s", async (_, headers) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));

    await withAgentUserAgent(fetcher)("https://bff.example", { headers });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("user-agent")).toBe("host/1.0");
  });

  it("keeps a Request's own headers when no init is given", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    const request = new Request("https://bff.example", {
      headers: { Authorization: "Bearer agent-token" },
    });

    await withAgentUserAgent(fetcher)(request);

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(fetcher.mock.calls[0]?.[0]).toBe(request);
    expect(headers.get("authorization")).toBe("Bearer agent-token");
    expect(headers.get("user-agent")).toBe(USER_AGENT);
  });

  it.each([
    ["an init without headers", { method: "POST" }, "Bearer agent-token"],
    // fetch lets init.headers replace a Request's own, and the wrapper keeps that.
    ["init headers", { headers: { Accept: "application/json" } }, null],
  ])("with a Request and %s, sends the expected headers", async (_, init, authorization) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    const request = new Request("https://bff.example", {
      headers: { Authorization: "Bearer agent-token" },
    });

    await withAgentUserAgent(fetcher)(request, init);

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(authorization);
    expect(headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("keeps a User-Agent a Request already sets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    const request = new Request("https://bff.example", { headers: { "User-Agent": "host/1.0" } });

    await withAgentUserAgent(fetcher)(request);

    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("user-agent")).toBe("host/1.0");
  });

  it("keeps the headers of a Request from another implementation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    // Shaped like a Request (a polyfill, or one from another realm) but not an instance of this one.
    const foreign = {
      url: "https://bff.example",
      headers: new Headers({ Authorization: "Bearer agent-token" }),
    } as unknown as Request;
    expect(foreign instanceof Request).toBe(false);

    await withAgentUserAgent(fetcher)(foreign);

    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer agent-token");
    expect(headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("leaves browser requests to the browser's own User-Agent", () => {
    vi.stubGlobal("process", undefined);
    const fetcher = vi.fn<typeof fetch>();

    expect(agentUserAgent()).toBeUndefined();
    expect(withAgentUserAgent(fetcher)).toBe(fetcher);
  });

  it("still marks the traffic as agentic when the version can't be read", () => {
    vi.stubGlobal("process", { versions: { node: "24.0.0" } });

    expect(agentUserAgent()).toBe("ledger-agent-intent-sdk/unknown (agentic)");
  });
});
