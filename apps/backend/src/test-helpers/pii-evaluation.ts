import type {
  PiiAppliedPolicy,
  PiiDecision,
  PiiProtectionService,
  PiiServiceEvaluateTextInput
} from "../services/pii/pii-protection-service.js";

/**
 * A text evaluation fake made from a fake that gives only a decision. The
 * applied policy is fixed, so a test can check that the caller records it.
 */
export function textEvaluation(
  evaluateText: (input: PiiServiceEvaluateTextInput) => Promise<PiiDecision>,
  appliedPolicy: PiiAppliedPolicy = { mode: "detect", revision: 1 }
): Pick<PiiProtectionService, "evaluateTextWithPolicy"> {
  return {
    evaluateTextWithPolicy: async (input) => ({ decision: await evaluateText(input), appliedPolicy })
  };
}
