import { localAuthErrorCode, localAuthMessage } from "../../lib/local-auth-api";

export function passwordFieldError(error: unknown, hasCurrentPassword = false): { field: "current" | "password"; message: string } | null {
  const code = localAuthErrorCode(error);
  if (hasCurrentPassword && code === "invalid_credentials") {
    return { field: "current", message: "Your current password is not correct. Try again." };
  }
  if (code?.startsWith("password_")) {
    return { field: "password", message: localAuthMessage(error, "Choose another password.") };
  }
  return null;
}
