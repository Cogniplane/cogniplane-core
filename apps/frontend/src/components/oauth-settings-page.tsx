export function buildOAuthFlashMessage(input: {
  provider: string;
  result: string | null;
  reason: string | null;
  successMessage: string;
}): string | null {
  if (input.result === "connected") return input.successMessage;
  // The account security changed after the authorization started, so the
  // backend stored nothing (an older session started it).
  if (input.result === "error" && input.reason === "session_changed") return "Your session changed. Connect again.";
  if (input.result === "error") {
    return input.reason
      ? `${input.provider} authorization failed: ${input.reason.replaceAll("_", " ")}.`
      : `${input.provider} authorization failed.`;
  }
  return null;
}
