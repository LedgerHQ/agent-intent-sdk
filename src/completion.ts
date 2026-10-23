import { AgentIntentSdkError } from "./bytes.ts";
import { isEnrollmentEnvironment } from "./requestFields.ts";

export const AGENT_ENROLLMENT_COMPLETION_VERSION = 1;
export const AGENT_ENROLLMENT_WITH_ACCOUNT_ACCESS_VERSION = 2;

export type DirectApp16AccountAccessCompletion = {
  /**
   * Legacy wire name retained for compatibility. The controlled experiment
   * currently grants OWNER without CAN_ADD_BLOCK, not KEY_READER.
   */
  mode: "direct-app16-key-reader";
  environment: "staging" | "production";
  trustchainId: string;
  applicationPath: string;
};

export type AgentEnrollmentCompletionV1 = {
  version: typeof AGENT_ENROLLMENT_COMPLETION_VERSION;
  agentPubkey: string;
  trustchainId: string;
};

export type AgentEnrollmentCompletionV2 = {
  version: typeof AGENT_ENROLLMENT_WITH_ACCOUNT_ACCESS_VERSION;
  agentPubkey: string;
  trustchainId: string;
  accountAccess: DirectApp16AccountAccessCompletion;
};

export type AgentEnrollmentCompletion = AgentEnrollmentCompletionV1 | AgentEnrollmentCompletionV2;

export function serializeAgentEnrollmentCompletion(
  completion: Omit<AgentEnrollmentCompletionV1, "version"> & {
    accountAccess?: DirectApp16AccountAccessCompletion;
  },
): string {
  assertCompletionFields(completion);
  if (completion.accountAccess !== undefined) assertAccountAccess(completion.accountAccess);
  return JSON.stringify(
    {
      version:
        completion.accountAccess === undefined
          ? AGENT_ENROLLMENT_COMPLETION_VERSION
          : AGENT_ENROLLMENT_WITH_ACCOUNT_ACCESS_VERSION,
      agentPubkey: completion.agentPubkey,
      trustchainId: completion.trustchainId,
      ...(completion.accountAccess === undefined
        ? {}
        : { accountAccess: completion.accountAccess }),
    },
    null,
    2,
  );
}

export function parseAgentEnrollmentCompletion(
  payload: string,
  expectedAgentPubkey: string,
): AgentEnrollmentCompletion {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new AgentIntentSdkError("Enrollment completion must be valid JSON.");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedCompletion();
  }
  const completion = value as Record<string, unknown>;
  if (typeof completion.agentPubkey !== "string" || typeof completion.trustchainId !== "string") {
    throw malformedCompletion();
  }
  if (completion.version === AGENT_ENROLLMENT_COMPLETION_VERSION) {
    if (
      completion.accountAccess !== undefined ||
      Object.keys(completion).sort().join(",") !== "agentPubkey,trustchainId,version"
    ) {
      throw malformedCompletion();
    }
  } else if (completion.version === AGENT_ENROLLMENT_WITH_ACCOUNT_ACCESS_VERSION) {
    if (
      Object.keys(completion).sort().join(",") !== "accountAccess,agentPubkey,trustchainId,version"
    ) {
      throw malformedCompletion();
    }
    assertAccountAccess(completion.accountAccess);
  } else {
    throw malformedCompletion();
  }
  assertCompletionFields(completion as Omit<AgentEnrollmentCompletionV1, "version">);

  if (completion.agentPubkey.toLowerCase() !== expectedAgentPubkey.toLowerCase()) {
    throw new AgentIntentSdkError(
      "Enrollment completion does not match the pending agent identity.",
    );
  }

  return completion as AgentEnrollmentCompletion;
}

function assertCompletionFields(completion: { agentPubkey: string; trustchainId: string }): void {
  if (completion.agentPubkey.length === 0 || completion.trustchainId.length === 0) {
    throw malformedCompletion();
  }
}

function assertAccountAccess(value: unknown): asserts value is DirectApp16AccountAccessCompletion {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "applicationPath,environment,mode,trustchainId" ||
    (value as DirectApp16AccountAccessCompletion).mode !== "direct-app16-key-reader" ||
    !isEnrollmentEnvironment((value as DirectApp16AccountAccessCompletion).environment) ||
    typeof (value as DirectApp16AccountAccessCompletion).trustchainId !== "string" ||
    !(value as DirectApp16AccountAccessCompletion).trustchainId ||
    typeof (value as DirectApp16AccountAccessCompletion).applicationPath !== "string" ||
    !/^m\/0'\/16'\/[0-9]+'$/.test((value as DirectApp16AccountAccessCompletion).applicationPath)
  ) {
    throw malformedCompletion();
  }
}

function malformedCompletion(): AgentIntentSdkError {
  return new AgentIntentSdkError(
    "Enrollment completion must contain a supported version, agentPubkey, trustchainId, and valid accountAccess when version is 2.",
  );
}
