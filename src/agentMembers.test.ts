import { describe, expect, it } from "vitest";
import {
  encodeAgentMemberName,
  encodeBrowserMemberName,
  isAgentMember,
  normalizeAgentKey,
} from "./agentMembers.ts";
import { AgentIntentSdkError } from "./bytes.ts";

// LKRP's Permissions.MEMBER and Permissions.KEY_READER.
const MEMBER = 0;
const KEY_READER = 0x01;

describe("Trustchain member names", () => {
  it("encodes browser names containing Unicode, colons, and percent characters", () => {
    expect(encodeBrowserMemberName("Quentin's Ledger: 100% 🔐")).toBe(
      "agent-intent:v1:browser:Quentin's%20Ledger%3A%20100%25%20%F0%9F%94%90",
    );
  });

  it("uses the plain agent display name without a prefix or version", () => {
    expect(encodeAgentMemberName("Épargne: 50% 🤖")).toBe("Épargne: 50% 🤖");
  });

  it("rejects empty and over-long encoder inputs", () => {
    expect(() => encodeBrowserMemberName(" ")).toThrow(AgentIntentSdkError);
    expect(() => encodeAgentMemberName("")).toThrow(AgentIntentSdkError);
    expect(() => encodeAgentMemberName("a".repeat(81))).toThrow(AgentIntentSdkError);
    expect(encodeAgentMemberName("a".repeat(80))).toHaveLength(80);
  });

  it.each([
    ["agent", encodeAgentMemberName],
    ["browser", encodeBrowserMemberName],
  ])("rejects an %s name cut in the middle of an emoji", (_, encode) => {
    const cut = `${"a".repeat(79)}🤖`.slice(0, 80);

    expect(() => encode(cut)).toThrow("must be well-formed Unicode");
  });

  it("accepts an agent name of 212 UTF-8 bytes, the most an LKRP member name holds", () => {
    const name = `${"中".repeat(70)}ab`;

    expect(new TextEncoder().encode(name)).toHaveLength(212);
    expect(encodeAgentMemberName(name)).toBe(name);
  });

  it.each([
    ["an agent name over 212 UTF-8 bytes", () => encodeAgentMemberName("中".repeat(71))],
    // 24 bytes of prefix, then 9 per percent-encoded "中": 213.
    [
      "a browser name whose encoding exceeds 212 bytes",
      () => encodeBrowserMemberName("中".repeat(21)),
    ],
  ])("rejects %s", (_, encode) => {
    expect(encode).toThrow("at most 212 bytes in UTF-8");
  });

  it("classifies identify-only members independently of their stored name", () => {
    const valid = { id: "agent", name: encodeAgentMemberName("Buyer"), permissions: MEMBER };

    const legacy = { ...valid, name: "legacy encoded value" };
    const keyReader = { ...valid, permissions: KEY_READER };

    expect(isAgentMember(valid)).toBe(true);
    expect(isAgentMember(legacy)).toBe(true);
    expect(isAgentMember(keyReader)).toBe(false);
  });

  it("normalizes an agent key to lowercase", () => {
    expect(normalizeAgentKey("02AbCd")).toBe("02abcd");
  });
});
