import type { AgentIntentRecord } from "./intentPage.ts";

type Lifecycle = AgentIntentRecord["status"];

const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 8;

export function isActionableIntentStatus(status: Lifecycle): boolean {
  return status === "created" || status === "crafted";
}

export function isSubmittedIntentStatus(status: Lifecycle): boolean {
  return (
    status === "signed" || status === "broadcast" || status === "success" || status === "failed"
  );
}

/** Once the BFF accepted the broadcast, only a terminal status can move an intent on. */
export function submittedIntentStatus(status: Lifecycle): "broadcast" | "success" | "failed" {
  return isTerminal(status) ? status : "broadcast";
}

export type IntentLifecycleState = {
  lifecycle: Lifecycle;
  broadcastAccepted?: boolean;
  transactionId?: string;
};

export type IntentLifecycleEvent =
  | { type: "ACCEPTED" }
  | { type: "RECEIPT"; transactionId: string }
  | { type: "LIFECYCLE"; lifecycle: Lifecycle };

/** Keeps the app's own fields, such as its device action state. */
export function intentLifecycleReducer<State extends IntentLifecycleState>(
  state: State,
  event: IntentLifecycleEvent,
): Omit<State, keyof IntentLifecycleState> & IntentLifecycleState {
  switch (event.type) {
    case "ACCEPTED":
      // A late or repeated acceptance keeps a terminal status.
      return {
        ...state,
        broadcastAccepted: true,
        lifecycle: submittedIntentStatus(state.lifecycle),
      };
    case "RECEIPT":
      return {
        ...state,
        broadcastAccepted: true,
        lifecycle: submittedIntentStatus(state.lifecycle),
        transactionId: event.transactionId,
      };
    case "LIFECYCLE":
      if (!state.broadcastAccepted) return { ...state, lifecycle: event.lifecycle };
      // A read can still predate this app's broadcast.
      return isTerminal(state.lifecycle) || !isTerminal(event.lifecycle)
        ? state
        : { ...state, lifecycle: event.lifecycle };
  }
}

/** An error thrown by `onRefreshed` rejects the polling. */
export async function pollIntentLifecycle<Intent extends { status: Lifecycle }>({
  intentId,
  attempts = POLL_ATTEMPTS,
  refresh,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  isCurrentRun = () => true,
  onRefreshed,
}: {
  intentId: string;
  /** Reads, one second apart. Defaults to 8. */
  attempts?: number;
  refresh(intentId: string): Promise<Intent>;
  wait?(milliseconds: number): Promise<void>;
  /** `false` once the app no longer follows this run: its late reads are dropped. */
  isCurrentRun?(): boolean;
  onRefreshed(intent: Intent): void;
}): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(POLL_INTERVAL_MS);
    if (!isCurrentRun()) return;

    let refreshed: Intent;
    try {
      refreshed = await refresh(intentId);
    } catch {
      // A transient read failure doesn't undo an accepted broadcast.
      continue;
    }
    if (!isCurrentRun()) return;

    onRefreshed(refreshed);
    if (isTerminal(refreshed.status)) return;
  }
}

function isTerminal(status: Lifecycle): status is "success" | "failed" {
  return status === "success" || status === "failed";
}
