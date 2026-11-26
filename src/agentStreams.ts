import {
  isAgentMember,
  normalizeAgentKey,
  type AgentIntentTrustchainMember,
} from "./agentMembers.ts";
import { AgentIntentSdkError } from "./bytes.ts";

export type AgentIntentTrustchainStream<
  Member extends AgentIntentTrustchainMember = AgentIntentTrustchainMember,
> = {
  path: string;
  closed: boolean;
  members: readonly Member[];
};

// trustchain-backend defaults to a maximum depth of 6.
export const APP_18_BACKEND_MAX_TREE_DEPTH = 6;
const HARDENED_CHILD_COUNT = 0x80000000;

export function agentSubtreeNamespace(applicationPath: string, agentPublicKey: string): string {
  const bytes = parseCompressedPublicKey(agentPublicKey);
  const index =
    (((bytes[1] ?? 0) << 23) |
      ((bytes[2] ?? 0) << 15) |
      ((bytes[3] ?? 0) << 7) |
      ((bytes[4] ?? 0) >>> 1)) >>>
    0;
  return `${applicationPath}/${index}'`;
}

export function nextAgentSubtreePath(
  applicationPath: string,
  agentPublicKey: string,
  subtrees: readonly AgentIntentTrustchainStream[],
): string {
  const baseObject = agentSubtreeNamespace(applicationPath, agentPublicKey);
  const baseIndex = Number.parseInt(baseObject.slice(applicationPath.length + 1), 10);
  const latest = latestAgentSubtreeGenerations(applicationPath, subtrees);

  // At most latest.size objects can be occupied, so the next probe is free.
  for (let offset = 0; offset <= latest.size; offset += 1) {
    const objectPath = `${applicationPath}/${(baseIndex + offset) % HARDENED_CHILD_COUNT}'`;
    const existing = latest.get(objectPath);
    if (existing === undefined) return checkedStreamPath(applicationPath, `${objectPath}/0'`);
    if (!hasMember(existing.subtree, agentPublicKey)) continue;
    if (!existing.subtree.closed) return existing.subtree.path;
    return checkedStreamPath(applicationPath, `${objectPath}/${existing.generation + 1}'`);
  }
  throw new AgentIntentSdkError("Unable to allocate an App-18 agent subtree.");
}

export function isAgentSubtreeStreamPath(applicationPath: string, path: string): boolean {
  return agentSubtreeStreamPattern(applicationPath).test(path);
}

export function assertApp18SubtreePathDepth(applicationPath: string, path: string): void {
  if (!path.startsWith(`${applicationPath}/`)) {
    throw new AgentIntentSdkError(
      `App-18 subtree path ${path} is not below the application stream ${applicationPath}.`,
    );
  }
  const depth = pathDepth(path);
  if (depth > APP_18_BACKEND_MAX_TREE_DEPTH) {
    throw new AgentIntentSdkError(
      `App-18 subtree path depth ${depth} exceeds the supported backend maximum ` +
        `${APP_18_BACKEND_MAX_TREE_DEPTH}.`,
    );
  }
}

export function findOpenAgentSubtree<Stream extends AgentIntentTrustchainStream>(
  subtrees: readonly Stream[],
  agentPublicKey: string,
): Stream | undefined {
  return subtrees.find((subtree) => !subtree.closed && hasMember(subtree, agentPublicKey));
}

export function findOpenAgentSubtreeStream<Stream extends AgentIntentTrustchainStream>(
  applicationPath: string,
  subtrees: readonly Stream[],
  agentPublicKey: string,
): Stream | undefined {
  const latest = [...latestAgentSubtreeGenerations(applicationPath, subtrees).values()];
  return findOpenAgentSubtree(
    latest.map(({ subtree }) => subtree),
    agentPublicKey,
  );
}

export function discoverAgentMembers<Member extends AgentIntentTrustchainMember>(
  subtrees: readonly AgentIntentTrustchainStream<Member>[],
): Member[] {
  const byPublicKey = new Map<string, Member>();
  for (const subtree of subtrees) {
    if (subtree.closed) continue;
    for (const member of subtree.members) {
      if (isAgentMember(member)) byPublicKey.set(normalizeAgentKey(member.id), member);
    }
  }
  return [...byPublicKey.values()];
}

export function mergeMembers<Member extends AgentIntentTrustchainMember>(
  ...groups: readonly (readonly Member[])[]
): Member[] {
  const members = new Map<string, Member>();
  for (const member of groups.flat()) {
    members.set(normalizeAgentKey(member.id), member);
  }
  return [...members.values()];
}

/** Agents still identified directly in a shared application stream. */
export function legacyAgentMembers<Member extends AgentIntentTrustchainMember>(
  members: readonly Member[],
  currentMemberId: string,
): Member[] {
  const current = normalizeAgentKey(currentMemberId);
  return members.filter(
    (member) => normalizeAgentKey(member.id) !== current && isAgentMember(member),
  );
}

function latestAgentSubtreeGenerations<Stream extends AgentIntentTrustchainStream>(
  applicationPath: string,
  subtrees: readonly Stream[],
): Map<string, { generation: number; subtree: Stream }> {
  const pattern = agentSubtreeStreamPattern(applicationPath);
  const latest = new Map<string, { generation: number; subtree: Stream }>();
  for (const subtree of subtrees) {
    const match = pattern.exec(subtree.path);
    if (match === null) continue;
    const objectPath = `${applicationPath}/${match[1]}'`;
    const generation = Number.parseInt(match[2] ?? "", 10);
    const current = latest.get(objectPath);
    if (current === undefined || generation > current.generation) {
      latest.set(objectPath, { generation, subtree });
    }
  }
  return latest;
}

function checkedStreamPath(applicationPath: string, path: string): string {
  assertApp18SubtreePathDepth(applicationPath, path);
  return path;
}

function hasMember(subtree: AgentIntentTrustchainStream, publicKey: string): boolean {
  const key = normalizeAgentKey(publicKey);
  return subtree.members.some((member) => normalizeAgentKey(member.id) === key);
}

function agentSubtreeStreamPattern(applicationPath: string): RegExp {
  return new RegExp(`^${escapeRegExp(applicationPath)}/(\\d+)'/(\\d+)'$`);
}

function parseCompressedPublicKey(agentPublicKey: string): Uint8Array {
  if (!/^0[23][0-9a-f]{64}$/i.test(agentPublicKey)) {
    throw new AgentIntentSdkError("Agent public key must be a compressed 33-byte key.");
  }
  return Uint8Array.from(agentPublicKey.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
