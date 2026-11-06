import { expect, it } from "vitest";

import { buildOAuthFlashMessage } from "./oauth-settings-page";

const input = { provider: "GitHub", successMessage: "GitHub connected." };

// q4w0.8 review: the backend refuses a callback whose authorization started
// before a security change (reason `session_changed`) and stores nothing.
it("tells the member to connect again after a session change", () => {
  expect(buildOAuthFlashMessage({ ...input, result: "error", reason: "session_changed" }))
    .toBe("Your session changed. Connect again.");
});

it("keeps the other outcomes", () => {
  expect(buildOAuthFlashMessage({ ...input, result: "connected", reason: null })).toBe("GitHub connected.");
  expect(buildOAuthFlashMessage({ ...input, result: "error", reason: "missing_code" }))
    .toBe("GitHub authorization failed: missing code.");
  expect(buildOAuthFlashMessage({ ...input, result: "error", reason: null })).toBe("GitHub authorization failed.");
  expect(buildOAuthFlashMessage({ ...input, result: null, reason: null })).toBeNull();
});
