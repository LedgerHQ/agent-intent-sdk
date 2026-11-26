import { describe, expect, it } from "vitest";
import {
  deriveAgentRestore,
  resolveAgent,
  resolveAgents,
  type AgentResourceStatus,
  type App18Members,
  type ProfileListResult,
  type ResourceStatus,
} from "./agentStatus.ts";
import type { AgentProfileRecord } from "./reviewerClient.ts";

// LKRP's Permissions.OWNER and Permissions.MEMBER.
const OWNER = 0xffffffff;
const MEMBER = 0;

const AGENT = "02AbCdEf01";
const OTHER_AGENT = "03fedcba02";

function profile(agentPubkey: string, source = "openclaw"): AgentProfileRecord {
  return {
    agentPubkey,
    profile: { name: `Agent ${agentPubkey}`, description: "Test agent", source },
    createdAt: "2026-04-16T09:00:00Z",
    updatedAt: "2026-04-16T09:00:00Z",
  };
}

function authenticated(memberIds: string[], currentMemberId = "frontend"): App18Members {
  return {
    currentMemberId,
    members: [
      { id: "frontend", name: "Frontend", permissions: OWNER },
      { id: "owner-device", name: "Owner", permissions: OWNER },
      ...memberIds.map((id) => ({ id, name: id, permissions: MEMBER })),
    ],
  };
}

const loaded = (...profiles: AgentProfileRecord[]): ProfileListResult => ({
  status: "success",
  profiles,
});

function enrolled(agentPubkey: string, createdAt: string): AgentProfileRecord {
  return { ...profile(agentPubkey), createdAt };
}

describe("resolveAgents", () => {
  it("marks an agent with a profile and an App-18 member as present", () => {
    const result = resolveAgents({
      profiles: loaded(profile(AGENT)),
      app18: authenticated([AGENT]),
    });

    expect(result).toMatchObject({ source: "profiles", loading: false, unrecognized: [] });
    expect(result.agents).toEqual([
      expect.objectContaining({
        pubkey: AGENT,
        key: AGENT.toLowerCase(),
        member: expect.objectContaining({ id: AGENT }),
        profile: expect.objectContaining({ agentPubkey: AGENT }),
        status: { app18: "present", app16: "unknown", profile: "present" },
      }),
    ]);
  });

  it("marks App-18 missing for a profile without a member", () => {
    const result = resolveAgents({ profiles: loaded(profile(AGENT)), app18: authenticated([]) });

    expect(result.agents[0]?.member).toBeUndefined();
    expect(result.agents[0]?.status).toEqual({
      app18: "missing",
      app16: "unknown",
      profile: "present",
    });
  });

  it("reports App-18 members without a profile as unrecognized", () => {
    const result = resolveAgents({
      profiles: loaded(profile(AGENT)),
      app18: authenticated([AGENT, OTHER_AGENT]),
    });

    expect(result.agents.map(({ pubkey }) => pubkey)).toEqual([AGENT]);
    expect(result.unrecognized).toEqual([
      expect.objectContaining({
        pubkey: OTHER_AGENT,
        member: expect.objectContaining({ id: OTHER_AGENT }),
        status: expect.objectContaining({ app18: "present", profile: "missing" }),
      }),
    ]);
    expect(result.unrecognized[0]?.profile).toBeUndefined();
  });

  it("never claims App-18 missing while the App-18 session is unknown", () => {
    const result = resolveAgents({ profiles: loaded(profile(AGENT)), app18: undefined });

    expect(result.agents[0]?.status.app18).toBe("unknown");
    expect(result.unrecognized).toEqual([]);
  });

  it("falls back to App-18 members when the profile list fails", () => {
    const result = resolveAgents({
      profiles: { status: "error" },
      app18: authenticated([AGENT, OTHER_AGENT]),
    });

    expect(result).toMatchObject({ source: "app18-fallback", loading: false, unrecognized: [] });
    expect(result.agents.map(({ pubkey }) => pubkey)).toEqual([AGENT, OTHER_AGENT]);
    for (const agent of result.agents) {
      expect(agent.profile).toBeUndefined();
      expect(agent.status).toEqual({ app18: "present", app16: "unknown", profile: "unknown" });
    }
  });

  it("claims nothing while the profile list loads", () => {
    expect(
      resolveAgents({ profiles: { status: "loading" }, app18: authenticated([AGENT]) }),
    ).toEqual({ source: "profiles", loading: true, agents: [], unrecognized: [] });
  });

  it("matches profiles to members case-insensitively and keeps the profile casing", () => {
    const result = resolveAgents({
      profiles: loaded(profile(AGENT)),
      app18: authenticated([AGENT.toLowerCase()]),
    });

    expect(result.unrecognized).toEqual([]);
    expect(result.agents[0]).toMatchObject({
      pubkey: AGENT,
      member: { id: AGENT.toLowerCase() },
      status: { app18: "present" },
    });
  });

  it("excludes the current member and non-agent members", () => {
    const result = resolveAgents({
      profiles: loaded(),
      app18: authenticated([AGENT, "CURRENT"], "current"),
    });

    expect(result.unrecognized.map(({ pubkey }) => pubkey)).toEqual([AGENT]);
  });

  it("keeps a profile with an unsupported source as an other agent", () => {
    const result = resolveAgents({
      profiles: loaded(profile(AGENT, "trading"), profile(OTHER_AGENT)),
      app18: authenticated([AGENT, OTHER_AGENT]),
    });

    expect(result.agents.map(({ pubkey, profile }) => [pubkey, profile?.profile.source])).toEqual([
      [AGENT, "other"],
      [OTHER_AGENT, "openclaw"],
    ]);
    expect(result.unrecognized).toEqual([]);
  });

  it("looks App-16 up by the lowercased key, whatever the profile's casing", () => {
    const result = resolveAgents({
      profiles: loaded(profile(AGENT), profile(OTHER_AGENT)),
      app18: authenticated([AGENT, OTHER_AGENT]),
      app16: (key) => (key === AGENT.toLowerCase() ? "present" : "missing"),
    });

    expect(result.agents.map(({ status }) => status.app16)).toEqual(["present", "missing"]);
  });

  it("lists agents oldest enrollment first, whatever order the BFF returns them in", () => {
    const result = resolveAgents({
      profiles: loaded(
        enrolled("since-15-oct", "2026-10-15T08:00:00Z"),
        enrolled("since-04-nov", "2026-11-04T08:00:00Z"),
        enrolled("since-19-oct", "2026-10-19T08:00:00Z"),
        enrolled("since-23-oct", "2026-10-23T08:00:00Z"),
      ),
      app18: authenticated([]),
    });

    expect(result.agents.map(({ pubkey }) => pubkey)).toEqual([
      "since-15-oct",
      "since-19-oct",
      "since-23-oct",
      "since-04-nov",
    ]);
  });

  it("lists a profile with an unparsable enrollment date last", () => {
    const result = resolveAgents({
      profiles: loaded(
        enrolled("since-23-oct", "2026-10-23T08:00:00Z"),
        enrolled("unparsable", "not a date"),
        enrolled("since-15-oct", "2026-10-15T08:00:00Z"),
        enrolled("since-19-oct", "2026-10-19T08:00:00Z"),
      ),
      app18: authenticated([]),
    });

    expect(result.agents.map(({ pubkey }) => pubkey)).toEqual([
      "since-15-oct",
      "since-19-oct",
      "since-23-oct",
      "unparsable",
    ]);
  });
});

describe("resolveAgent", () => {
  it("finds an agent in the profile list case-insensitively", () => {
    const agent = resolveAgent({
      pubkey: AGENT.toLowerCase(),
      profiles: loaded(profile(AGENT)),
      app18: authenticated([AGENT]),
    });

    expect(agent).toMatchObject({
      pubkey: AGENT,
      profile: { agentPubkey: AGENT },
      status: { app18: "present", profile: "present" },
    });
  });

  it("uses the optional profile when the list is unavailable", () => {
    const app18 = authenticated([AGENT]);

    expect(
      resolveAgent({
        pubkey: AGENT,
        app18,
        profiles: { status: "error" },
        profile: { status: "success", profile: profile(AGENT) },
      }).status.profile,
    ).toBe("present");
    expect(
      resolveAgent({ pubkey: AGENT, app18, profile: { status: "success", profile: null } }).status
        .profile,
    ).toBe("missing");
    expect(
      resolveAgent({ pubkey: AGENT, app18, profile: { status: "success", profile: undefined } })
        .status.profile,
    ).toBe("missing");
    expect(
      resolveAgent({ pubkey: AGENT, app18, profile: { status: "error" } }).status.profile,
    ).toBe("unknown");
    expect(resolveAgent({ pubkey: AGENT, app18 }).status.profile).toBe("unknown");
  });

  it("reports a fully missing agent only when every read succeeded", () => {
    expect(
      resolveAgent({
        pubkey: AGENT,
        app18: authenticated([]),
        profiles: loaded(),
        app16: () => "missing",
      }).status,
    ).toEqual({ app18: "missing", app16: "missing", profile: "missing" });
    expect(resolveAgent({ pubkey: AGENT, app18: undefined, profiles: loaded() }).status.app18).toBe(
      "unknown",
    );
  });

  it("does not resolve the current member as an agent", () => {
    expect(
      resolveAgent({ pubkey: "FRONTEND", app18: authenticated([]), profiles: loaded() }).status
        .app18,
    ).toBe("missing");
  });

  it("resolves a profile with an unsupported source as an other agent", () => {
    const agent = resolveAgent({
      pubkey: AGENT,
      app18: authenticated([AGENT]),
      profiles: loaded(profile(AGENT, "trading")),
    });

    expect(agent.profile?.profile.source).toBe("other");
    expect(agent.status.profile).toBe("present");
  });
});

describe("deriveAgentRestore", () => {
  const STATUSES: ResourceStatus[] = ["present", "missing", "unknown"];

  it.each<[AgentResourceStatus, ReturnType<typeof deriveAgentRestore>]>([
    [{ app18: "missing", app16: "present", profile: "present" }, "agent-access"],
    [{ app18: "present", app16: "missing", profile: "present" }, "account-access"],
    [{ app18: "missing", app16: "missing", profile: "present" }, undefined],
    [{ app18: "present", app16: "present", profile: "present" }, undefined],
    [{ app18: "present", app16: "present", profile: "missing" }, undefined],
    [{ app18: "present", app16: "missing", profile: "missing" }, undefined],
    [{ app18: "missing", app16: "present", profile: "missing" }, undefined],
  ])("%o offers %s", (status, expected) => {
    expect(deriveAgentRestore(status)).toBe(expected);
  });

  it("never offers a restore when a status it depends on is unknown", () => {
    for (const app16 of STATUSES) {
      for (const profile of STATUSES) {
        expect(deriveAgentRestore({ app18: "unknown", app16, profile })).toBeUndefined();
      }
    }
    for (const app18 of STATUSES) {
      for (const profile of STATUSES) {
        expect(deriveAgentRestore({ app18, app16: "unknown", profile })).toBeUndefined();
      }
    }
    for (const app18 of STATUSES) {
      for (const app16 of STATUSES) {
        expect(deriveAgentRestore({ app18, app16, profile: "unknown" })).toBeUndefined();
      }
    }
  });
});
