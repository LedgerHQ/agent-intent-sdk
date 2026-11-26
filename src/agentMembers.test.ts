import { describe, expect, it } from "vitest";
import {
  encodeAgentMemberName,
  encodeBrowserMemberName,
  isBrowserMemberName,
  parseAgentMember,
  parseMemberName,
} from "./agentMembers.ts";
import { AgentIntentSdkError } from "./bytes.ts";

// LKRP's Permissions.MEMBER and Permissions.KEY_READER.
const MEMBER = 0;
const KEY_READER = 0x01;

describe("Trustchain member names", () => {
  it("round trips browser names containing Unicode, colons, and percent characters", () => {
    const browserName = "Quentin's Ledger: 100% 🔐";

    const encodedBrowser = encodeBrowserMemberName(browserName);

    expect(encodedBrowser).toBe(
      "agent-intent:v1:browser:Quentin's%20Ledger%3A%20100%25%20%F0%9F%94%90",
    );
    expect(parseMemberName(encodedBrowser)).toEqual({
      version: "v1",
      kind: "browser",
      name: browserName,
    });
    expect(isBrowserMemberName(encodedBrowser)).toBe(true);
  });

  it("uses the plain agent display name without a prefix or version", () => {
    expect(encodeAgentMemberName("Épargne: 50% 🤖")).toBe("Épargne: 50% 🤖");
  });

  it.each([
    "agent-intent:v2:agent:openclaw:Agent",
    "agent-intent:v1:unknown:Agent",
    "agent-intent:v1:browser",
    "agent-intent:v1:browser:Browser:extra",
    "agent-intent:v1:agent:openclaw",
    "agent-intent:v1:agent:openclaw:Agent:extra",
    "agent-intent:v1:agent:unsupported:Agent",
    "agent-intent:v1:agent:trading:Legacy%20Type",
    "agent-intent:v1:agent:openclaw:",
    "agent-intent:v1:agent:openclaw:%20%20",
    "agent-intent:v1:agent:openclaw:bad%escape",
    "agent-intent:v1:agent:openclaw:%E0%A4%A",
    "agent-intent:v1:agent:openclaw:raw name",
    "Portfolio Agent",
  ])("fails closed for invalid member name %s", (value) => {
    expect(parseMemberName(value)).toBeUndefined();
    expect(isBrowserMemberName(value)).toBe(false);
  });

  it("rejects empty and over-long encoder inputs", () => {
    expect(() => encodeBrowserMemberName(" ")).toThrow(AgentIntentSdkError);
    expect(() => encodeAgentMemberName("")).toThrow(AgentIntentSdkError);
    expect(() => encodeAgentMemberName("a".repeat(81))).toThrow(AgentIntentSdkError);
    expect(encodeAgentMemberName("a".repeat(80))).toHaveLength(80);
  });

  it("rejects a browser name cut in the middle of an emoji", () => {
    const cut = `${"a".repeat(79)}🤖`.slice(0, 80);

    expect(() => encodeBrowserMemberName(cut)).toThrow(AgentIntentSdkError);
  });

  it("classifies identify-only members independently of their stored name", () => {
    const valid = { id: "agent", name: encodeAgentMemberName("Buyer"), permissions: MEMBER };

    expect(parseAgentMember(valid)).toEqual({ member: valid });
    expect(parseAgentMember({ ...valid, name: "legacy encoded value" })).toEqual({
      member: { ...valid, name: "legacy encoded value" },
    });
    expect(parseAgentMember({ ...valid, permissions: KEY_READER })).toBeUndefined();
  });
});
