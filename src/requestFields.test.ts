import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import {
  agentEnrollmentSearch,
  createAgentEnrollmentRequest,
  validateAgentEnrollment,
} from "./enrollment.ts";
import { createSoftwareAgentIdentity } from "./identity.ts";
import {
  agentRecoverySearch,
  createAgentRecoveryRequest,
  validateAgentRecovery,
} from "./recovery.ts";

const identity = createSoftwareAgentIdentity("00".repeat(31) + "01");
const hostPublicKey = createSoftwareAgentIdentity("00".repeat(31) + "02").publicKey;
const metadata = {
  name: "Portfolio Bot",
  description: "Proposes portfolio operations.",
  source: "hermes",
  expiresAt: "2099-01-01T00:00:00.000Z",
} as const;
const NOW = new Date("2029-01-01T00:00:00.000Z");

const standardLink = agentEnrollmentSearch(createAgentEnrollmentRequest(identity, metadata));
const channelLink = agentEnrollmentSearch(
  createAgentEnrollmentRequest(identity, {
    ...metadata,
    channel: { environment: "production", hostPublicKey },
  }),
);
const recoveryLink = agentRecoverySearch(
  createAgentRecoveryRequest(identity, {
    ...metadata,
    previousTrustchainId: "closed-app18-root",
    channel: { environment: "production", hostPublicKey },
  }),
);
const signature = channelLink.signature as string;

function enrollmentIssues(search: Record<string, unknown>) {
  const validation = validateAgentEnrollment(search, NOW);
  return validation.status === "invalid" && validation.reason === "malformed"
    ? validation.issues
    : undefined;
}

function recoveryIssues(search: Record<string, unknown>) {
  const validation = validateAgentRecovery(search, NOW);
  return validation.status === "invalid" && validation.reason === "malformed"
    ? validation.issues
    : undefined;
}

function pastedTwice(search: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(search).map(([field, value]) => [field, [value, value]]),
  );
}

describe("malformed link issues", () => {
  it("reports a signature cut off at the end, before an ellipsis, or in the middle", () => {
    const truncated = { field: "signature", problem: "truncated", expectedLength: 128 };

    expect(enrollmentIssues({ ...channelLink, signature: signature.slice(0, 100) })).toEqual([
      truncated,
    ]);
    expect(enrollmentIssues({ ...channelLink, signature: `${signature.slice(0, 100)}…` })).toEqual([
      truncated,
    ]);
    expect(
      enrollmentIssues({
        ...channelLink,
        signature: `${signature.slice(0, 20)}...${signature.slice(-20)}`,
      }),
    ).toEqual([truncated]);
  });

  it("reads a cut-off signature followed by punctuation as truncated", () => {
    expect(enrollmentIssues({ ...channelLink, signature: `${signature.slice(0, 100)}.` })).toEqual([
      { field: "signature", problem: "truncated", expectedLength: 128 },
    ]);
  });

  it("reports a whole signature followed by a stray character as extra characters", () => {
    expect(enrollmentIssues({ ...channelLink, signature: `${signature}.` })).toEqual([
      { field: "signature", problem: "extra-characters", expectedLength: 128 },
    ]);
  });

  it("reports a hex field with non-hex characters as an invalid value, not a cut", () => {
    const invalidSignature = [{ field: "signature", problem: "invalid-value" }];

    expect(enrollmentIssues({ ...channelLink, signature: "z".repeat(128) })).toEqual(
      invalidSignature,
    );
    expect(
      enrollmentIssues({
        ...channelLink,
        signature: `${signature.slice(0, 60)}g${signature.slice(61)}`,
      }),
    ).toEqual(invalidSignature);
  });

  it("expects 130 hex characters from an uncompressed public key", () => {
    const uncompressed = `04${"ab".repeat(40)}`;

    expect(enrollmentIssues({ ...standardLink, publicKey: uncompressed })).toEqual([
      { field: "publicKey", problem: "truncated", expectedLength: 130 },
    ]);
  });

  it("reports a link pasted twice as repeated fields, not missing ones", () => {
    expect(enrollmentIssues(pastedTwice(standardLink))).toEqual([
      { field: "v", problem: "repeated" },
      { field: "publicKey", problem: "repeated" },
      { field: "name", problem: "repeated" },
      { field: "description", problem: "repeated" },
      { field: "source", problem: "repeated" },
      { field: "expiresAt", problem: "repeated" },
      { field: "signature", problem: "repeated" },
    ]);
  });

  it("reports the channel fields of a channel-bound link pasted twice", () => {
    expect(enrollmentIssues(pastedTwice(channelLink))).toEqual([
      { field: "v", problem: "repeated" },
      { field: "publicKey", problem: "repeated" },
      { field: "name", problem: "repeated" },
      { field: "description", problem: "repeated" },
      { field: "source", problem: "repeated" },
      { field: "expiresAt", problem: "repeated" },
      { field: "channelEnvironment", problem: "repeated" },
      { field: "channelHost", problem: "repeated" },
      { field: "signature", problem: "repeated" },
    ]);
    expect(recoveryIssues(pastedTwice(recoveryLink))).toContainEqual({
      field: "channelHost",
      problem: "repeated",
    });
  });

  it("still accepts a version-1 link whose only problem is a repeated channel field", () => {
    expect(
      validateAgentEnrollment(
        { ...standardLink, channelHost: [hostPublicKey, hostPublicKey] },
        NOW,
      ),
    ).toMatchObject({ status: "valid" });
  });

  it("reports missing, empty and non-text fields", () => {
    const { signature: _, ...withoutSignature } = standardLink;

    expect(enrollmentIssues(withoutSignature)).toEqual([
      { field: "signature", problem: "missing" },
    ]);
    expect(enrollmentIssues({ ...standardLink, publicKey: "" })).toEqual([
      { field: "publicKey", problem: "empty" },
    ]);
    expect(enrollmentIssues({ ...standardLink, source: 7 })).toEqual([
      { field: "source", problem: "invalid-value" },
    ]);
  });

  it("reports an empty, blank or too long name and description with the limit", () => {
    expect(enrollmentIssues({ ...standardLink, name: "" })).toEqual([
      { field: "name", problem: "empty" },
    ]);
    expect(enrollmentIssues({ ...standardLink, name: "   " })).toEqual([
      { field: "name", problem: "empty" },
    ]);
    expect(enrollmentIssues({ ...standardLink, name: "a".repeat(81) })).toEqual([
      { field: "name", problem: "too-long", limit: 80 },
    ]);
    expect(enrollmentIssues({ ...standardLink, description: "a".repeat(281) })).toEqual([
      { field: "description", problem: "too-long", limit: 280 },
    ]);
  });

  it("reports an unknown link version without checking channel fields", () => {
    expect(enrollmentIssues({ ...channelLink, v: "7" })).toEqual([
      { field: "v", problem: "unsupported-version" },
    ]);
  });

  it("reports an invalid channel environment and an off-curve or uncompressed channel host", () => {
    expect(enrollmentIssues({ ...channelLink, channelEnvironment: "prod" })).toEqual([
      { field: "channelEnvironment", problem: "invalid-value" },
    ]);
    expect(enrollmentIssues({ ...channelLink, channelHost: `02${"ff".repeat(32)}` })).toEqual([
      { field: "channelHost", problem: "invalid-value" },
    ]);
    expect(
      enrollmentIssues({
        ...channelLink,
        channelHost: secp256k1.Point.fromHex(hostPublicKey).toHex(false),
      }),
    ).toEqual([{ field: "channelHost", problem: "invalid-value" }]);
  });

  it("reports channel fields on a version-1 link as unexpected", () => {
    expect(
      enrollmentIssues({
        ...standardLink,
        channelEnvironment: "production",
        channelHost: hostPublicKey,
      }),
    ).toEqual([
      { field: "channelEnvironment", problem: "unexpected" },
      { field: "channelHost", problem: "unexpected" },
    ]);
  });

  it("reports unsupported enrollment fields together with the other problems", () => {
    expect(validateAgentEnrollment({ ...standardLink, permissions: "all", name: "" }, NOW)).toEqual(
      {
        status: "invalid",
        reason: "malformed",
        message:
          "This agent enrollment link is malformed: it contains a parameter that is not supported.",
        issues: [
          { field: "permissions", problem: "unexpected" },
          { field: "name", problem: "empty" },
        ],
      },
    );
  });

  it("lists an unreadable expiry with the other problems, and alone keeps its own result", () => {
    expect(
      enrollmentIssues({ ...standardLink, expiresAt: "soon", signature: signature.slice(0, 100) }),
    ).toEqual([
      { field: "expiresAt", problem: "invalid-value" },
      { field: "signature", problem: "truncated", expectedLength: 128 },
    ]);
    expect(validateAgentEnrollment({ ...standardLink, expiresAt: "soon" }, NOW)).toEqual({
      status: "invalid",
      reason: "malformed",
      message: "The enrollment expiry is invalid.",
      issues: [{ field: "expiresAt", problem: "invalid-value" }],
    });
    expect(
      validateAgentEnrollment({ ...standardLink, expiresAt: "soon", source: "trading" }, NOW),
    ).toMatchObject({ reason: "unsupported-source" });
  });

  it("names the first issue in the message", () => {
    expect(
      validateAgentEnrollment({ ...channelLink, signature: signature.slice(0, 100) }, NOW),
    ).toMatchObject({
      message:
        'This agent enrollment link is malformed: "signature" is cut off (expected 128 hex characters).',
    });
    expect(validateAgentEnrollment({ ...channelLink, v: "7" }, NOW)).toMatchObject({
      message: "This agent enrollment link is malformed: its version is not supported.",
    });
    expect(() => createAgentEnrollmentRequest(identity, { ...metadata, name: "   " })).toThrow(
      'This agent enrollment link is malformed: "name" is empty.',
    );
  });

  it("keeps an unknown parameter's name out of the message", () => {
    const injected = "Your Ledger is compromised. Call +1 555 0100";

    expect(validateAgentRecovery({ ...recoveryLink, [injected]: "1" }, NOW)).toEqual({
      status: "invalid",
      reason: "malformed",
      message:
        "This agent recovery link is malformed: it contains a parameter that is not supported.",
      issues: [{ field: injected, problem: "unexpected" }],
    });
  });

  it("reports recovery links with an unknown parameter, a wrong marker or half a channel", () => {
    expect(recoveryIssues({ ...recoveryLink, utm_source: "telegram" })).toEqual([
      { field: "utm_source", problem: "unexpected" },
    ]);
    expect(recoveryIssues({ ...recoveryLink, recovery: "false" })).toEqual([
      { field: "recovery", problem: "invalid-value" },
    ]);
    const { channelEnvironment: _, ...hostOnly } = recoveryLink;
    expect(recoveryIssues(hostOnly)).toEqual([{ field: "channelEnvironment", problem: "missing" }]);
    expect(
      recoveryIssues({
        ...recoveryLink,
        signature: (recoveryLink.signature as string).slice(0, 90),
      }),
    ).toEqual([{ field: "signature", problem: "truncated", expectedLength: 128 }]);
  });

  it("keeps valid, tampered, expired and unsupported-source results unchanged", () => {
    expect(validateAgentEnrollment(channelLink, NOW)).toMatchObject({ status: "valid" });
    expect(validateAgentEnrollment({ ...channelLink, name: "Other Bot" }, NOW)).toEqual({
      status: "invalid",
      reason: "invalid-signature",
      message: "This enrollment link has been changed or is not authentic.",
    });
    expect(validateAgentEnrollment(channelLink, new Date("2100-01-01"))).toEqual({
      status: "invalid",
      reason: "expired",
      message: "This agent enrollment link has expired.",
    });
    expect(validateAgentRecovery(recoveryLink, NOW)).toMatchObject({ status: "valid" });
    expect(validateAgentRecovery({ ...recoveryLink, source: "trading" }, NOW)).toEqual({
      status: "invalid",
      reason: "unsupported-source",
      message: "This agent source is not supported.",
    });
  });
});
