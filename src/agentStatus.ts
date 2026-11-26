import { parseAgentMember, type AgentIntentTrustchainMember } from "./agentMembers.ts";
import { isAgentSource, type AgentSource } from "./enrollment.ts";
import type { AgentProfileRecord } from "./reviewerClient.ts";

export type ResourceStatus = "present" | "missing" | "unknown";

export type AgentResourceStatus = {
  app18: ResourceStatus;
  app16: ResourceStatus;
  profile: ResourceStatus;
};

export type KnownAgentProfile = AgentProfileRecord & {
  profile: AgentProfileRecord["profile"] & { source: AgentSource };
};

export type ResolvedAgent<
  Member extends AgentIntentTrustchainMember = AgentIntentTrustchainMember,
> = {
  /** Original casing, for display and links. */
  pubkey: string;
  /** Lowercased pubkey used for matching. */
  key: string;
  profile?: KnownAgentProfile;
  member?: Member;
  status: AgentResourceStatus;
};

export type ProfileListResult =
  | { status: "loading" }
  | { status: "error" }
  | { status: "success"; profiles: readonly AgentProfileRecord[] };

/** `null` or `undefined`: the BFF has no profile for this key. */
export type OptionalProfileResult =
  | { status: "loading" }
  | { status: "error" }
  | { status: "success"; profile: AgentProfileRecord | null | undefined };

export type App18Members<
  Member extends AgentIntentTrustchainMember = AgentIntentTrustchainMember,
> =
  | {
      /** The current member and the agents of the App-18 agent streams (`discoverAgentMembers`). */
      members: readonly Member[];
      currentMemberId: string;
    }
  | undefined;

/** Receives the lowercased pubkey. */
export type App16Lookup = (key: string) => ResourceStatus;

export type ResolveAgentsInput<
  Member extends AgentIntentTrustchainMember = AgentIntentTrustchainMember,
> = {
  profiles: ProfileListResult;
  app18: App18Members<Member>;
  app16?: App16Lookup;
};

export type ResolvedAgents<
  Member extends AgentIntentTrustchainMember = AgentIntentTrustchainMember,
> = {
  source: "profiles" | "app18-fallback";
  /** The profile list is still loading; nothing is claimed missing. */
  loading: boolean;
  agents: ResolvedAgent<Member>[];
  /** App-18 agent members without a profile; only set once profiles loaded. */
  unrecognized: ResolvedAgent<Member>[];
};

export function normalizeAgentKey(pubkey: string): string {
  return pubkey.toLowerCase();
}

export function resolveAgents<Member extends AgentIntentTrustchainMember>({
  profiles,
  app18,
  app16 = unknownApp16,
}: ResolveAgentsInput<Member>): ResolvedAgents<Member> {
  const members = agentMembers(app18);

  if (profiles.status === "loading") {
    return { source: "profiles", loading: true, agents: [], unrecognized: [] };
  }

  if (profiles.status === "error") {
    return {
      source: "app18-fallback",
      loading: false,
      agents: [...(members?.values() ?? [])].map((member) =>
        resolved(member.id, undefined, member, "present", "unknown", app16),
      ),
      unrecognized: [],
    };
  }

  const profileKeys = new Set(
    profiles.profiles.map(({ agentPubkey }) => normalizeAgentKey(agentPubkey)),
  );
  const app18For = (key: string): ResourceStatus =>
    members === undefined ? "unknown" : members.has(key) ? "present" : "missing";

  // GET /v1/agent-profiles promises no order.
  const agents = [...profiles.profiles]
    .sort((a, b) => enrolledAt(a) - enrolledAt(b))
    .map((profile) => {
      const key = normalizeAgentKey(profile.agentPubkey);
      return resolved(
        profile.agentPubkey,
        toKnownAgentProfile(profile),
        members?.get(key),
        app18For(key),
        "present",
        app16,
      );
    });
  const unrecognized = [...(members?.entries() ?? [])].flatMap(([key, member]) =>
    profileKeys.has(key)
      ? []
      : [resolved(member.id, undefined, member, "present", "missing", app16)],
  );

  return { source: "profiles", loading: false, agents, unrecognized };
}

export type ResolveAgentInput<
  Member extends AgentIntentTrustchainMember = AgentIntentTrustchainMember,
> = {
  pubkey: string;
  app18: App18Members<Member>;
  /** Preferred when it loaded successfully. */
  profiles?: ProfileListResult;
  /** Used when the list is absent, loading or failed. */
  profile?: OptionalProfileResult;
  app16?: App16Lookup;
};

export function resolveAgent<Member extends AgentIntentTrustchainMember>({
  pubkey,
  app18,
  profiles,
  profile,
  app16 = unknownApp16,
}: ResolveAgentInput<Member>): ResolvedAgent<Member> {
  const key = normalizeAgentKey(pubkey);
  const members = agentMembers(app18);
  const member = members?.get(key);
  const app18Status: ResourceStatus =
    members === undefined ? "unknown" : member ? "present" : "missing";

  const found =
    profiles?.status === "success"
      ? { status: "success" as const, profile: findProfile(profiles.profiles, key) ?? null }
      : profile;
  let profileStatus: ResourceStatus = "unknown";
  let knownProfile: KnownAgentProfile | undefined;
  if (found?.status === "success") {
    if (found.profile === null || found.profile === undefined) profileStatus = "missing";
    // A query cache can still hold the previous agent's profile while this one loads.
    else if (normalizeAgentKey(found.profile.agentPubkey) === key) {
      profileStatus = "present";
      knownProfile = toKnownAgentProfile(found.profile);
    }
  }

  return resolved(
    knownProfile?.agentPubkey ?? member?.id ?? pubkey,
    knownProfile,
    member,
    app18Status,
    profileStatus,
    app16,
  );
}

/** The BFF accepts any source, so a legacy or unknown one shows as `other` instead of hiding the agent. */
export function toKnownAgentSource(source: string): AgentSource {
  return isAgentSource(source) ? source : "other";
}

function toKnownAgentProfile(agent: AgentProfileRecord): KnownAgentProfile {
  const { profile } = agent;
  return { ...agent, profile: { ...profile, source: toKnownAgentSource(profile.source) } };
}

/** Which missing Trustchain membership can be restored for an agent. */
export type AgentRestoreKind = "agent-access" | "account-access";

/** Device-signed Trustchain data proves the Ledger approved this key; a BFF profile alone doesn't. */
export function deriveAgentRestore(status: AgentResourceStatus): AgentRestoreKind | undefined {
  if (status.profile !== "present") return undefined;
  if (status.app18 === "missing" && status.app16 === "present") return "agent-access";
  if (status.app18 === "present" && status.app16 === "missing") return "account-access";
  return undefined;
}

function agentMembers<Member extends AgentIntentTrustchainMember>(
  app18: App18Members<Member>,
): Map<string, Member> | undefined {
  if (app18 === undefined) return undefined;
  const current = normalizeAgentKey(app18.currentMemberId);
  const result = new Map<string, Member>();
  for (const member of app18.members) {
    const key = normalizeAgentKey(member.id);
    if (key === current || !parseAgentMember(member)) continue;
    result.set(key, member);
  }
  return result;
}

function findProfile(
  profiles: readonly AgentProfileRecord[],
  key: string,
): AgentProfileRecord | undefined {
  return profiles.find(({ agentPubkey }) => normalizeAgentKey(agentPubkey) === key);
}

// An unparsable date sorts last instead of breaking the comparator; the max is above any real date.
function enrolledAt({ createdAt }: AgentProfileRecord): number {
  const time = Date.parse(createdAt);
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function resolved<Member extends AgentIntentTrustchainMember>(
  pubkey: string,
  profile: KnownAgentProfile | undefined,
  member: Member | undefined,
  app18: ResourceStatus,
  profileStatus: ResourceStatus,
  app16: App16Lookup,
): ResolvedAgent<Member> {
  const key = normalizeAgentKey(pubkey);
  return {
    pubkey,
    key,
    ...(profile ? { profile } : {}),
    ...(member ? { member } : {}),
    status: { app18, app16: app16(key), profile: profileStatus },
  };
}

const unknownApp16: App16Lookup = () => "unknown";
