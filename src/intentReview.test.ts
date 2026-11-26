import { describe, expect, it } from "vitest";
import { AgentIntentHttpError } from "./bffHttp.ts";
import {
  createIntentReviewAttempt,
  createOwnSignatures,
  intentReviewReducer,
  mayHaveRecordedSignature,
  SOLANA_CRAFT_LIFETIME_MS,
  type IntentReviewAttempt,
  type IntentReviewEvent,
} from "./intentReview.ts";

const SIGNATURE = `0x${"ab".repeat(64)}1b`;

function reduce(attempt: IntentReviewAttempt, ...events: IntentReviewEvent[]): IntentReviewAttempt {
  return events.reduce(intentReviewReducer, attempt);
}

function crafted(revision: number, at = 0): IntentReviewEvent {
  return { type: "CRAFTED", craft: { rawTransaction: `0x0${revision}`, revision }, at };
}

function signed(at = 0): IntentReviewEvent {
  return { type: "SIGNED", signature: SIGNATURE, at };
}

function httpError(status: number, type?: string): AgentIntentHttpError {
  return new AgentIntentHttpError(`BFF request failed (${status}).`, status, type);
}

const evm = () => createIntentReviewAttempt({ family: "evm" });
const solana = () => createIntentReviewAttempt({ family: "solana" });

describe("intentReviewReducer", () => {
  it("crafts, signs, submits and follows the accepted broadcast", () => {
    let attempt = evm();
    expect(attempt.step).toEqual({ type: "craft" });

    attempt = reduce(attempt, crafted(1));
    expect(attempt.step).toEqual({ type: "sign", rawTransaction: "0x01" });

    attempt = reduce(attempt, signed());
    expect(attempt.step).toEqual({
      type: "submit",
      submission: { signature: SIGNATURE, revision: 1 },
    });

    attempt = reduce(attempt, { type: "SUBMITTED", transactionId: "0xtx" });
    expect(attempt.step).toEqual({
      type: "accepted",
      lifecycle: "broadcast",
      transactionId: "0xtx",
    });
    expect(attempt.refreshed).toBe(false);
  });

  it("ignores an event that doesn't answer the current step", () => {
    const crafting = evm();
    const signing = reduce(evm(), crafted(1));

    expect(reduce(crafting, signed())).toBe(crafting);
    expect(reduce(crafting, { type: "SUBMITTED", transactionId: "0xtx" })).toBe(crafting);
    expect(reduce(signing, crafted(2))).toBe(signing);
    expect(reduce(signing, { type: "INTENT_READ", lifecycle: "signed" })).toBe(signing);
  });

  it("ignores every event once the attempt ended", () => {
    const ended = reduce(evm(), crafted(1), { type: "SIGN_FAILED", error: new Error("locked") });

    expect(reduce(ended, crafted(2))).toBe(ended);
    expect(reduce(ended, { type: "CRAFT_FAILED", error: httpError(409, "stale_revision") })).toBe(
      ended,
    );
  });

  describe("a stale revision", () => {
    it("crafts again and asks to sign the new transaction", () => {
      let attempt = reduce(evm(), crafted(1), signed(), {
        type: "SUBMIT_FAILED",
        error: httpError(409, "stale_revision"),
      });
      expect(attempt.step).toEqual({ type: "craft" });
      expect(attempt.refreshed).toBe(true);

      attempt = reduce(attempt, crafted(2), signed());
      expect(attempt.step).toEqual({
        type: "submit",
        submission: { signature: SIGNATURE, revision: 2 },
      });
    });

    it("stops with a retry when the refreshed signature is stale too", () => {
      const stale = httpError(409, "stale_revision");
      const attempt = reduce(
        evm(),
        crafted(1),
        signed(),
        { type: "SUBMIT_FAILED", error: stale },
        crafted(2),
        signed(),
        { type: "SUBMIT_FAILED", error: stale },
      );

      expect(attempt.step).toEqual({ type: "failed", phase: "broadcast", error: stale });
    });

    it.each(["stale_revision", "duplicate_event"])(
      "crafts again at once, without a refresh, when the craft answers %s",
      (type) => {
        const attempt = reduce(evm(), { type: "CRAFT_FAILED", error: httpError(409, type) });

        expect(attempt.step).toEqual({ type: "craft" });
        expect(attempt.refreshed).toBe(false);
      },
    );

    it("reports a craft failure when the second craft is refused too", () => {
      const conflict = httpError(409, "stale_revision");
      const attempt = reduce(
        evm(),
        { type: "CRAFT_FAILED", error: conflict },
        { type: "CRAFT_FAILED", error: conflict },
      );

      expect(attempt.step).toEqual({ type: "failed", phase: "craft", error: conflict });
    });

    it("crafts again at once after a refresh too", () => {
      const conflict = httpError(409, "duplicate_event");
      const attempt = reduce(
        evm(),
        { type: "CRAFT_FAILED", error: conflict },
        crafted(1),
        signed(),
        { type: "SUBMIT_FAILED", error: httpError(409, "stale_revision") },
        { type: "CRAFT_FAILED", error: conflict },
      );

      expect(attempt.step).toEqual({ type: "craft" });
    });
  });

  describe("a Solana craft", () => {
    it("is crafted again when the signature comes after its lifetime", () => {
      const attempt = reduce(
        solana(),
        crafted(1, 1_000),
        signed(1_000 + SOLANA_CRAFT_LIFETIME_MS + 1),
      );

      expect(attempt.step).toEqual({ type: "craft" });
      expect(attempt.refreshed).toBe(true);
    });

    it("is submitted when signed at the end of its lifetime", () => {
      const attempt = reduce(solana(), crafted(1, 1_000), signed(1_000 + SOLANA_CRAFT_LIFETIME_MS));

      expect(attempt.step.type).toBe("submit");
    });

    it("stops with a retry when the refreshed craft expires too", () => {
      const late = SOLANA_CRAFT_LIFETIME_MS + 1;
      const attempt = reduce(
        solana(),
        crafted(1, 0),
        signed(late),
        crafted(2, late),
        signed(2 * late),
      );

      expect(attempt.step).toEqual({ type: "craft-expired" });
    });

    it("refreshes once per attempt, whatever made it refresh", () => {
      const late = SOLANA_CRAFT_LIFETIME_MS + 1;
      const stale = httpError(409, "stale_revision");
      const attempt = reduce(
        solana(),
        crafted(1, 0),
        signed(late),
        crafted(2, late),
        signed(late),
        { type: "SUBMIT_FAILED", error: stale },
      );

      expect(attempt.step).toEqual({ type: "failed", phase: "broadcast", error: stale });
    });

    it("never expires on EVM", () => {
      const attempt = reduce(evm(), crafted(1, 0), signed(10 * SOLANA_CRAFT_LIFETIME_MS));

      expect(attempt.step.type).toBe("submit");
    });

    it("is crafted again, without a refresh, once the device installed its app", () => {
      const installed = new Error("Solana app installed");
      let attempt = reduce(solana(), crafted(1), { type: "APP_INSTALLED", error: installed });
      expect(attempt.step).toEqual({ type: "craft" });
      expect(attempt.refreshed).toBe(false);

      attempt = reduce(attempt, crafted(2), { type: "APP_INSTALLED", error: installed });
      expect(attempt.step).toEqual({ type: "failed", phase: "device", error: installed });
    });
  });

  it("fails on a device error", () => {
    const locked = new Error("locked");

    expect(reduce(evm(), crafted(1), { type: "SIGN_FAILED", error: locked }).step).toEqual({
      type: "failed",
      phase: "device",
      error: locked,
    });
  });

  it("ends as failed, without a retry, when the network refused the broadcast", () => {
    const attempt = reduce(evm(), crafted(1), signed(), {
      type: "SUBMIT_FAILED",
      error: httpError(400, "broadcast_rejected"),
    });

    expect(attempt.step).toEqual({ type: "submission-ended", lifecycle: "failed", refused: true });
  });

  describe("a craft the BFF refuses", () => {
    const refused = httpError(400);
    const refusedCraft = () => reduce(evm(), { type: "CRAFT_FAILED", error: refused });

    it("reads the intent after an untyped 400", () => {
      expect(refusedCraft().step).toEqual({ type: "read-intent" });
    });

    it("fails at once on a typed 400", () => {
      const typed = httpError(400, "invalid_craft_parameters");

      expect(reduce(evm(), { type: "CRAFT_FAILED", error: typed }).step).toEqual({
        type: "failed",
        phase: "craft",
        error: typed,
      });
    });

    it("leaves review when the intent was handled elsewhere", () => {
      expect(reduce(refusedCraft(), { type: "INTENT_READ", lifecycle: "signed" }).step).toEqual({
        type: "left-review",
        lifecycle: "signed",
        elsewhere: true,
      });
    });

    it.each([["created"], ["crafted"], [undefined]] as const)(
      "keeps the craft error when the intent reads as %s",
      (lifecycle) => {
        expect(reduce(refusedCraft(), { type: "INTENT_READ", lifecycle }).step).toEqual({
          type: "failed",
          phase: "craft",
          error: refused,
        });
      },
    );

    it("follows the intent as its own when an earlier signature may have been recorded", () => {
      const attempt = reduce(refusedCraft(), {
        type: "INTENT_READ",
        lifecycle: "signed",
        mayHaveSigned: true,
      });

      expect(attempt.step).toEqual({
        type: "submission-ended",
        lifecycle: "signed",
        refused: false,
      });
    });
  });

  describe("a submission that may have been recorded", () => {
    const unconfirmed = httpError(502);
    const submitted = () =>
      reduce(evm(), crafted(1), signed(), { type: "SUBMIT_FAILED", error: unconfirmed });

    it.each([
      ["a bad gateway", unconfirmed],
      ["an untyped 400", httpError(400)],
      ["a lost connection", new TypeError("Failed to fetch")],
    ])("reads the intent after %s", (_, error) => {
      expect(reduce(evm(), crafted(1), signed(), { type: "SUBMIT_FAILED", error }).step).toEqual({
        type: "read-intent",
      });
    });

    it.each(["failed", "signed"] as const)(
      "ends, without a retry, when the intent is %s",
      (lifecycle) => {
        expect(reduce(submitted(), { type: "INTENT_READ", lifecycle }).step).toEqual({
          type: "submission-ended",
          lifecycle,
          refused: false,
        });
      },
    );

    it.each(["broadcast", "success"] as const)(
      "follows the broadcast when the intent is %s",
      (lifecycle) => {
        expect(reduce(submitted(), { type: "INTENT_READ", lifecycle }).step).toEqual({
          type: "accepted",
          lifecycle,
        });
      },
    );

    it.each(["rejected", "cancelled", "expired"] as const)(
      "leaves review as its own when the intent is %s",
      (lifecycle) => {
        expect(reduce(submitted(), { type: "INTENT_READ", lifecycle }).step).toEqual({
          type: "left-review",
          lifecycle,
          elsewhere: false,
        });
      },
    );

    it("keeps the retry when the BFF didn't record the signature", () => {
      expect(reduce(submitted(), { type: "INTENT_READ", lifecycle: "crafted" }).step).toEqual({
        type: "failed",
        phase: "broadcast",
        error: unconfirmed,
      });
    });

    it("keeps the retry when the intent can't be read", () => {
      expect(reduce(submitted(), { type: "INTENT_READ", lifecycle: undefined }).step).toEqual({
        type: "failed",
        phase: "broadcast",
        error: unconfirmed,
      });
    });
  });

  describe("a signature the BFF refused with a conflict", () => {
    const conflict = httpError(409, "duplicate_event");
    const refused = () =>
      reduce(evm(), crafted(1), signed(), { type: "SUBMIT_FAILED", error: conflict });

    it("reads the intent and leaves review when it moved on elsewhere", () => {
      const attempt = refused();
      expect(attempt.step).toEqual({ type: "read-intent" });

      expect(reduce(attempt, { type: "INTENT_READ", lifecycle: "broadcast" }).step).toEqual({
        type: "left-review",
        lifecycle: "broadcast",
        elsewhere: true,
      });
    });

    it("keeps the retry when the intent can still be reviewed", () => {
      expect(reduce(refused(), { type: "INTENT_READ", lifecycle: "crafted" }).step).toEqual({
        type: "failed",
        phase: "broadcast",
        error: conflict,
      });
    });
  });

  it("fails at once on a submission error before the request", () => {
    const invalid = new Error("The signature must be lowercase hex.");

    expect(
      reduce(evm(), crafted(1), signed(), { type: "SUBMIT_FAILED", error: invalid }).step,
    ).toEqual({ type: "failed", phase: "broadcast", error: invalid });
  });
});

describe("own signatures", () => {
  it.each([
    ["a conflict", httpError(409, "duplicate_event"), false],
    ["an untyped 400", httpError(400), true],
    ["a bad gateway", httpError(502), true],
    ["a lost connection", new TypeError("Failed to fetch"), true],
    ["an error before the request", new Error("Not a signed transaction"), false],
  ])("know whether %s may have recorded the signature", (_, error, recorded) => {
    expect(mayHaveRecordedSignature(error)).toBe(recorded);
  });

  it("keep an earlier unanswered signature when a later one is refused", async () => {
    const signatures = createOwnSignatures();
    const refused = Promise.reject(httpError(409, "duplicate_event"));

    signatures.track("intent-1", new Promise(() => {}));
    signatures.track("intent-1", refused);
    await refused.catch(() => {});

    expect(signatures.mayHaveSigned("intent-1")).toBe(true);
    expect(signatures.mayHaveSigned("intent-2")).toBe(false);
  });

  it("forget a signature the BFF refused", async () => {
    const signatures = createOwnSignatures();
    const refused = Promise.reject(httpError(409, "duplicate_event"));

    signatures.track("intent-1", refused);
    await refused.catch(() => {});

    expect(signatures.mayHaveSigned("intent-1")).toBe(false);
  });
});
