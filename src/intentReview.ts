import { AgentIntentHttpError } from "./bffHttp.ts";
import { AgentIntentSdkError } from "./bytes.ts";
import { isActionableIntentStatus } from "./intentLifecycle.ts";
import type { AgentIntentRecord, AgentIntentStatus } from "./intentPage.ts";
import {
  isAgentIntentErrorType,
  isStaleRevisionError,
  type AgentIntentCraft,
  type AgentIntentSignatureSubmission,
} from "./reviewerClient.ts";

type Lifecycle = AgentIntentRecord["status"];

/** A Solana blockhash expires after about a minute, and submitting an expired one fails the intent. */
export const SOLANA_CRAFT_LIFETIME_MS = 45_000;

export type IntentReviewPhase = "craft" | "device" | "broadcast";

/** What the app does next. The last five end the attempt. */
export type IntentReviewStep =
  | { type: "craft" }
  | { type: "sign"; rawTransaction: string }
  | { type: "submit"; submission: AgentIntentSignatureSubmission }
  /** Read the intent: its status decides how an unclear failure ends. */
  | { type: "read-intent" }
  | { type: "accepted"; lifecycle: "broadcast" | "success"; transactionId?: string }
  /** No retry: the BFF ended the intent, or kept it signed without a broadcast. */
  | { type: "submission-ended"; lifecycle: "failed" | "signed"; refused: boolean }
  /** `elsewhere`: this app's signature can't be what moved the intent on. */
  | { type: "left-review"; lifecycle: Lifecycle; elsewhere: boolean }
  | { type: "craft-expired" }
  | { type: "failed"; phase: IntentReviewPhase; error: unknown };

/** The app reads `step` and `refreshed`; the other fields are the reducer's own. */
export type IntentReviewAttempt = {
  readonly family: "evm" | "solana";
  readonly step: IntentReviewStep;
  readonly refreshed: boolean;
  readonly retriedCraft: boolean;
  readonly appInstalled: boolean;
  readonly crafted?: { readonly revision: number; readonly at: number };
  readonly failure?: { readonly phase: IntentReviewPhase; readonly error: unknown };
};

export type IntentReviewEvent =
  /** `at`: when the craft returned, in milliseconds. */
  | { type: "CRAFTED"; craft: Pick<AgentIntentCraft, "rawTransaction" | "revision">; at: number }
  | { type: "CRAFT_FAILED"; error: unknown }
  /** `signature` as `submitSignature` takes it; `at`: when the device signed, in milliseconds. */
  | { type: "SIGNED"; signature: string; at: number }
  | { type: "APP_INSTALLED"; error: unknown }
  | { type: "SIGN_FAILED"; error: unknown }
  | { type: "SUBMITTED"; transactionId: string }
  | { type: "SUBMIT_FAILED"; error: unknown }
  /** `undefined` when the read failed. `mayHaveSigned` covers this app's earlier submissions. */
  | { type: "INTENT_READ"; lifecycle: Lifecycle | undefined; mayHaveSigned?: boolean };

export function createIntentReviewAttempt({
  family,
}: {
  family: IntentReviewAttempt["family"];
}): IntentReviewAttempt {
  return {
    family,
    step: { type: "craft" },
    refreshed: false,
    retriedCraft: false,
    appInstalled: false,
  };
}

/** An event that doesn't answer the current step leaves the attempt as it is. */
export function intentReviewReducer(
  attempt: IntentReviewAttempt,
  event: IntentReviewEvent,
): IntentReviewAttempt {
  const { step } = attempt;
  switch (event.type) {
    case "CRAFTED":
      if (step.type !== "craft") return attempt;
      // A Solana wire transaction in base64 can't start with "0x".
      if (event.craft.rawTransaction.startsWith("0x") !== (attempt.family === "evm")) {
        return failed(
          attempt,
          "craft",
          new AgentIntentSdkError(`The crafted transaction isn't a ${attempt.family} transaction.`),
        );
      }
      return {
        ...attempt,
        step: { type: "sign", rawTransaction: event.craft.rawTransaction },
        retriedCraft: false,
        crafted: { revision: event.craft.revision, at: event.at },
      };
    case "CRAFT_FAILED":
      if (step.type !== "craft") return attempt;
      if (isConcurrentCraft(event.error) && !attempt.retriedCraft) {
        return { ...attempt, step: { type: "craft" }, retriedCraft: true };
      }
      // The BFF refuses to craft an intent that left review with a 400 of no documented type.
      if (isHttpError(event.error, 400) && !isAgentIntentErrorType(event.error.type)) {
        return readIntent(attempt, "craft", event.error);
      }
      return failed(attempt, "craft", event.error);
    case "SIGNED":
      if (step.type !== "sign" || attempt.crafted === undefined) return attempt;
      if (attempt.family === "solana" && event.at - attempt.crafted.at > SOLANA_CRAFT_LIFETIME_MS) {
        return attempt.refreshed
          ? { ...attempt, step: { type: "craft-expired" } }
          : recraft(attempt);
      }
      return {
        ...attempt,
        step: {
          type: "submit",
          submission: { signature: event.signature, revision: attempt.crafted.revision },
        },
      };
    case "APP_INSTALLED":
      if (step.type !== "sign") return attempt;
      if (attempt.appInstalled) return failed(attempt, "device", event.error);
      return { ...attempt, step: { type: "craft" }, appInstalled: true };
    case "SIGN_FAILED":
      if (step.type !== "sign") return attempt;
      return failed(attempt, "device", event.error);
    case "SUBMITTED":
      if (step.type !== "submit") return attempt;
      return {
        ...attempt,
        step: { type: "accepted", lifecycle: "broadcast", transactionId: event.transactionId },
      };
    case "SUBMIT_FAILED":
      if (step.type !== "submit") return attempt;
      // Crafted again since: sign the new transaction, once.
      if (isStaleRevisionError(event.error) && !attempt.refreshed) return recraft(attempt);
      if (
        event.error instanceof AgentIntentHttpError &&
        event.error.type === "broadcast_rejected"
      ) {
        return {
          ...attempt,
          step: { type: "submission-ended", lifecycle: "failed", refused: true },
        };
      }
      // The BFF may hold this signature, or refused it because the intent moved on.
      if (
        mayHaveRecordedSignature(event.error) ||
        (isHttpError(event.error, 409) && !isStaleRevisionError(event.error))
      ) {
        return readIntent(attempt, "broadcast", event.error);
      }
      return failed(attempt, "broadcast", event.error);
    case "INTENT_READ":
      if (step.type !== "read-intent" || attempt.failure === undefined) return attempt;
      return { ...attempt, step: settledStep(attempt.failure, event) };
  }
}

function settledStep(
  failure: NonNullable<IntentReviewAttempt["failure"]>,
  { lifecycle, mayHaveSigned }: Extract<IntentReviewEvent, { type: "INTENT_READ" }>,
): IntentReviewStep {
  if (lifecycle === undefined || isActionableIntentStatus(lifecycle)) {
    return { type: "failed", ...failure };
  }
  const ownSignature =
    mayHaveSigned === true ||
    (failure.phase === "broadcast" && mayHaveRecordedSignature(failure.error));
  if (!ownSignature) return { type: "left-review", lifecycle, elsewhere: true };
  if (isOneOf(lifecycle, ["failed", "signed"])) {
    return { type: "submission-ended", lifecycle, refused: false };
  }
  if (isOneOf(lifecycle, ["broadcast", "success"])) return { type: "accepted", lifecycle };
  // The BFF has no transition from Signed to Rejected or Cancelled.
  const elsewhere = isOneOf(lifecycle, ["rejected", "cancelled"]);
  return { type: "left-review", lifecycle, elsewhere };
}

// `===` doesn't narrow away the open `string & {}` of a status.
function isOneOf<const Statuses extends readonly AgentIntentStatus[]>(
  lifecycle: Lifecycle,
  statuses: Statuses,
): lifecycle is Statuses[number] {
  return statuses.some((status) => status === lifecycle);
}

export function mayHaveRecordedSignature(error: unknown): boolean {
  if (error instanceof AgentIntentHttpError) return error.status !== 409;
  // A failed or aborted fetch may have sent the request already.
  return error instanceof TypeError || error instanceof DOMException;
}

export type OwnSignatures = {
  /** Call with each `submitSignature` promise. */
  track(intentId: string, submission: Promise<unknown>): void;
  /** A submission of this app may have been recorded, even one the user stopped following. */
  mayHaveSigned(intentId: string): boolean;
};

export function createOwnSignatures(): OwnSignatures {
  const counts = new Map<string, number>();
  const count = (intentId: string, change: 1 | -1) =>
    counts.set(intentId, (counts.get(intentId) ?? 0) + change);
  return {
    track(intentId, submission) {
      count(intentId, 1);
      submission.catch((error: unknown) => {
        if (!mayHaveRecordedSignature(error)) count(intentId, -1);
      });
    },
    mayHaveSigned: (intentId) => (counts.get(intentId) ?? 0) > 0,
  };
}

function recraft(attempt: IntentReviewAttempt): IntentReviewAttempt {
  return { ...attempt, step: { type: "craft" }, refreshed: true };
}

function readIntent(
  attempt: IntentReviewAttempt,
  phase: IntentReviewPhase,
  error: unknown,
): IntentReviewAttempt {
  return { ...attempt, step: { type: "read-intent" }, failure: { phase, error } };
}

function failed(
  attempt: IntentReviewAttempt,
  phase: IntentReviewPhase,
  error: unknown,
): IntentReviewAttempt {
  return { ...attempt, step: { type: "failed", phase, error } };
}

function isConcurrentCraft(error: unknown): boolean {
  return (
    isHttpError(error, 409) && (error.type === "stale_revision" || error.type === "duplicate_event")
  );
}

function isHttpError(error: unknown, status: number): error is AgentIntentHttpError {
  return error instanceof AgentIntentHttpError && error.status === status;
}
