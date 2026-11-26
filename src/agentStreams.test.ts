import { describe, expect, it } from "vitest";
import { AgentIntentSdkError } from "./bytes.ts";
import {
  APP_18_BACKEND_MAX_TREE_DEPTH,
  agentSubtreeNamespace,
  assertApp18SubtreePathDepth,
  discoverAgentMembers,
  findOpenAgentSubtreeStream,
  isAgentSubtreeStreamPath,
  legacyAgentMembers,
  mergeMembers,
  nextAgentSubtreePath,
} from "./agentStreams.ts";

const applicationPath = "m/0'/18'/0'";
const agentPublicKey = `02${"12345678".repeat(8)}`;
const objectPath = `${applicationPath}/152709948'`;
const agent = { id: agentPublicKey, name: "Agent", permissions: 0 };

describe("App-18 agent subtree association", () => {
  it("derives a stable object container from the application path and public key", () => {
    expect(agentSubtreeNamespace(applicationPath, agentPublicKey)).toBe(objectPath);
    expect(APP_18_BACKEND_MAX_TREE_DEPTH).toBe(6);
  });

  it("refuses a key that isn't a compressed 33-byte public key", () => {
    const refuse = () => agentSubtreeNamespace(applicationPath, `04${"12".repeat(32)}`);

    expect(refuse).toThrow(AgentIntentSdkError);
    expect(refuse).toThrow("Agent public key must be a compressed 33-byte key.");
  });

  it("allocates generation 0 of the agent's object at the backend maximum depth", () => {
    const path = nextAgentSubtreePath(applicationPath, agentPublicKey, []);

    expect(path).toBe(`${objectPath}/0'`);
    expect(path.split("/")).toHaveLength(APP_18_BACKEND_MAX_TREE_DEPTH);
    expect(isAgentSubtreeStreamPath(applicationPath, path)).toBe(true);
    expect(isAgentSubtreeStreamPath(applicationPath, objectPath)).toBe(false);
  });

  it("derives the next generation after the agent's latest generation was closed", () => {
    expect(
      nextAgentSubtreePath(applicationPath, agentPublicKey, [
        { path: `${objectPath}/0'`, members: [agent], closed: true },
        { path: `${objectPath}/1'`, members: [agent], closed: true },
      ]),
    ).toBe(`${objectPath}/2'`);
  });

  it("resumes an agent-first interrupted enrollment from authoritative membership", () => {
    const partial = `${objectPath}/0'`;

    expect(
      nextAgentSubtreePath(applicationPath, agentPublicKey, [
        { path: partial, members: [agent], closed: false },
      ]),
    ).toBe(partial);
  });

  it.each([
    ["open", false],
    ["closed", true],
  ])("never reuses another agent's %s colliding object", (_state, closed) => {
    const collidingAgent = `03${agentPublicKey.slice(2, 10)}${"ab".repeat(28)}`;

    expect(
      nextAgentSubtreePath(applicationPath, collidingAgent, [
        { path: `${objectPath}/0'`, members: [agent], closed },
      ]),
    ).toBe(`${applicationPath}/152709949'/0'`);
  });

  it("wraps past the last object index when the agent's object is taken", () => {
    const lastIndexAgent = `02${"ff".repeat(4)}${"00".repeat(28)}`;
    const lastObject = `${applicationPath}/2147483647'`;

    expect(agentSubtreeNamespace(applicationPath, lastIndexAgent)).toBe(lastObject);
    expect(
      nextAgentSubtreePath(applicationPath, lastIndexAgent, [
        { path: `${lastObject}/0'`, members: [agent], closed: false },
      ]),
    ).toBe(`${applicationPath}/0'/0'`);
  });

  it("refuses an agent stream below an application path too deep for the backend", () => {
    expect(() => nextAgentSubtreePath(`${applicationPath}/1'`, agentPublicKey, [])).toThrow(
      "exceeds the supported backend maximum 6",
    );
  });

  it("does not claim an unattributable frontend-only partial stream", () => {
    expect(
      nextAgentSubtreePath(applicationPath, agentPublicKey, [
        {
          path: `${objectPath}/0'`,
          members: [{ id: `03${"11".repeat(32)}`, name: "Frontend", permissions: 3 }],
          closed: false,
        },
      ]),
    ).toBe(`${applicationPath}/152709949'/0'`);
  });

  it("ignores streams outside the object/generation layout for allocation", () => {
    expect(
      nextAgentSubtreePath(applicationPath, agentPublicKey, [
        { path: objectPath, members: [agent], closed: true },
        { path: `${objectPath}/0'/1'`, members: [agent], closed: true },
      ]),
    ).toBe(`${objectPath}/0'`);
  });

  it("finds only the agent's open latest-generation stream", () => {
    const closed = { path: `${objectPath}/1'`, members: [agent], closed: true };
    const stale = { path: `${objectPath}/0'`, members: [agent], closed: false };
    const other = { path: `${applicationPath}/7'/0'`, members: [agent], closed: false };
    const retired = { path: `${applicationPath}/9'`, members: [agent], closed: false };

    expect(
      findOpenAgentSubtreeStream(applicationPath, [stale, closed, retired], agentPublicKey),
    ).toBeUndefined();
    expect(
      findOpenAgentSubtreeStream(applicationPath, [closed, other], agentPublicKey.toUpperCase()),
    ).toBe(other);
  });

  it("rejects over-depth paths in the local preflight", () => {
    const refuse = () =>
      assertApp18SubtreePathDepth(applicationPath, `${applicationPath}/1'/2'/3'`);

    expect(refuse).toThrow(AgentIntentSdkError);
    expect(refuse).toThrow("exceeds the supported backend maximum 6");
  });

  it.each([applicationPath, "m/0'/19'/0'/1'/0'", `${applicationPath}0'/1'`])(
    "rejects %s as not below the application stream",
    (path) => {
      expect(() => assertApp18SubtreePathDepth(applicationPath, path)).toThrow(
        `App-18 subtree path ${path} is not below the application stream ${applicationPath}.`,
      );
    },
  );

  it("accepts an agent stream path within the backend depth", () => {
    expect(() => assertApp18SubtreePathDepth(applicationPath, `${objectPath}/0'`)).not.toThrow();
  });

  it("discovers only zero-permission agents from open subtrees", () => {
    expect(
      discoverAgentMembers([
        {
          path: `${applicationPath}/1'/0'`,
          members: [{ id: `03${"11".repeat(32)}`, name: "Frontend", permissions: 3 }, agent],
          closed: false,
        },
        {
          path: `${applicationPath}/2'/0'`,
          members: [{ ...agent, id: `03${"22".repeat(32)}` }],
          closed: true,
        },
      ]),
    ).toEqual([agent]);
  });

  it("lists an agent once when two open streams hold it under different casings", () => {
    const lower = { ...agent, id: `02${"ab".repeat(32)}` };
    const upper = { ...lower, id: lower.id.toUpperCase() };

    expect(
      discoverAgentMembers([
        { path: `${applicationPath}/1'/0'`, members: [lower], closed: false },
        { path: `${applicationPath}/7'/0'`, members: [upper], closed: false },
      ]),
    ).toEqual([upper]);
  });
});

describe("App-18 agent members across streams", () => {
  const browser = {
    id: `03${"aa".repeat(32)}`,
    name: "agent-intent:v1:browser:Mac",
    permissions: 3,
  };

  it("merges members by key, case-insensitively, keeping the last copy", () => {
    const upper = { ...agent, id: agent.id.toUpperCase(), name: "Renamed" };

    expect(mergeMembers([agent, browser], [upper])).toEqual([upper, browser]);
  });

  it("lists the agents left in a shared stream, without the current member", () => {
    const current = { ...agent, id: `02${"bb".repeat(32)}` };

    expect(legacyAgentMembers([browser, agent, current], current.id.toUpperCase())).toEqual([
      agent,
    ]);
  });
});
