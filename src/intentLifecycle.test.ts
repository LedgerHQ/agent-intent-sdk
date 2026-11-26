import { describe, expect, it, vi } from "vitest";
import {
  intentLifecycleReducer,
  isActionableIntentStatus,
  isSubmittedIntentStatus,
  pollIntentLifecycle,
  submittedIntentStatus,
  type IntentLifecycleState,
} from "./intentLifecycle.ts";
import { AGENT_INTENT_STATUSES } from "./intentPage.ts";

describe("intent statuses", () => {
  // Status, actionable, submitted, status after this app's accepted broadcast.
  const statuses = [
    ["created", true, false, "broadcast"],
    ["crafted", true, false, "broadcast"],
    ["signed", false, true, "broadcast"],
    ["broadcast", false, true, "broadcast"],
    ["success", false, true, "success"],
    ["failed", false, true, "failed"],
    ["rejected", false, false, "broadcast"],
    ["cancelled", false, false, "broadcast"],
    ["expired", false, false, "broadcast"],
  ] as const;

  it("covers every status", () => {
    expect(statuses.map(([status]) => status)).toEqual([...AGENT_INTENT_STATUSES]);
  });

  it.each(statuses)("classifies %s", (status, actionable, submitted, afterBroadcast) => {
    expect(isActionableIntentStatus(status)).toBe(actionable);
    expect(isSubmittedIntentStatus(status)).toBe(submitted);
    expect(submittedIntentStatus(status)).toBe(afterBroadcast);
  });

  it("treats a status a newer BFF adds as neither actionable nor submitted", () => {
    expect(isActionableIntentStatus("queued")).toBe(false);
    expect(isSubmittedIntentStatus("queued")).toBe(false);
    expect(submittedIntentStatus("queued")).toBe("broadcast");
  });
});

describe("intentLifecycleReducer", () => {
  it("keeps the receipt while the lifecycle reaches a terminal status", () => {
    let state: IntentLifecycleState = intentLifecycleReducer(
      { lifecycle: "crafted" },
      { type: "RECEIPT", transactionId: "0xtx" },
    );
    expect(state).toEqual({
      lifecycle: "broadcast",
      broadcastAccepted: true,
      transactionId: "0xtx",
    });

    state = intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: "broadcast" });
    state = intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: "failed" });
    expect(state).toEqual({ lifecycle: "failed", broadcastAccepted: true, transactionId: "0xtx" });
    expect(intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: "broadcast" })).toBe(
      state,
    );
  });

  it("keeps the first terminal status after an accepted broadcast", () => {
    let state: IntentLifecycleState = intentLifecycleReducer(
      { lifecycle: "crafted" },
      { type: "ACCEPTED" },
    );
    state = intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: "success" });

    expect(intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: "failed" })).toBe(state);
  });

  it.each(["created", "crafted", "signed", "rejected", "expired"] as const)(
    "ignores a late %s status once the broadcast was accepted",
    (lateStatus) => {
      const state = intentLifecycleReducer(
        { lifecycle: "crafted" },
        { type: "RECEIPT", transactionId: "0xtx" },
      );

      expect(intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: lateStatus })).toBe(
        state,
      );
    },
  );

  it.each(["created", "crafted", "signed"] as const)(
    "ignores a late %s status once the broadcast was accepted without a receipt",
    (lateStatus) => {
      const state = intentLifecycleReducer({ lifecycle: "crafted" }, { type: "ACCEPTED" });

      expect(state).toEqual({ lifecycle: "broadcast", broadcastAccepted: true });
      expect(intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: lateStatus })).toBe(
        state,
      );
      expect(intentLifecycleReducer(state, { type: "LIFECYCLE", lifecycle: "success" })).toEqual({
        lifecycle: "success",
        broadcastAccepted: true,
      });
    },
  );

  it.each(["success", "failed"] as const)(
    "follows any change of a %s intent this app didn't broadcast",
    (terminalStatus) => {
      expect(
        intentLifecycleReducer(
          { lifecycle: terminalStatus },
          { type: "LIFECYCLE", lifecycle: "created" },
        ),
      ).toEqual({ lifecycle: "created" });
    },
  );

  it("keeps the app's own fields", () => {
    const state = { lifecycle: "crafted", deviceAction: { status: "pending" } } as const;

    expect(intentLifecycleReducer(state, { type: "ACCEPTED" })).toEqual({
      lifecycle: "broadcast",
      broadcastAccepted: true,
      deviceAction: { status: "pending" },
    });
  });
});

describe("pollIntentLifecycle", () => {
  it("reads until the intent succeeds", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ status: "broadcast" })
      .mockResolvedValue({ status: "success" });
    const wait = vi.fn(async () => {});
    const onRefreshed = vi.fn();

    await pollIntentLifecycle({ intentId: "intent-1", refresh, wait, onRefreshed });

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith("intent-1");
    expect(onRefreshed.mock.calls).toEqual([[{ status: "broadcast" }], [{ status: "success" }]]);
  });

  it("stops a run the app no longer follows before applying a late read", async () => {
    let resolveRefresh!: (value: { status: "success" }) => void;
    const refresh = vi.fn(
      () =>
        new Promise<{ status: "success" }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    let current = true;
    const onRefreshed = vi.fn();
    const polling = pollIntentLifecycle({
      intentId: "intent-1",
      attempts: 3,
      refresh,
      wait: vi.fn(async () => {}),
      isCurrentRun: () => current,
      onRefreshed,
    });

    current = false;
    resolveRefresh({ status: "success" });
    await polling;

    expect(onRefreshed).not.toHaveBeenCalled();
  });

  it("bounds failed reads, one second apart", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("temporary failure");
    });
    const wait = vi.fn(async () => {});

    await pollIntentLifecycle({
      intentId: "intent-1",
      attempts: 3,
      refresh,
      wait,
      onRefreshed: vi.fn(),
    });

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
  });

  it("reads 8 times by default", async () => {
    const refresh = vi.fn(async () => ({ status: "broadcast" as const }));

    await pollIntentLifecycle({
      intentId: "intent-1",
      refresh,
      wait: async () => {},
      onRefreshed: vi.fn(),
    });

    expect(refresh).toHaveBeenCalledTimes(8);
  });
});
