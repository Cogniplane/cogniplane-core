// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeLogin = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  completeAccountSetup: vi.fn(), completePasswordReset: vi.fn(), startSignInEnrollment: vi.fn(), confirmSignInEnrollment: vi.fn(),
  fetchAuthConfig: vi.fn(), enrollPasskeyInSignIn: vi.fn()
}));
const browser = vi.hoisted(() => ({ passkeysSupported: vi.fn(() => true) }));
vi.mock("../../lib/passkey-browser", async (importOriginal) => ({ ...(await importOriginal<object>()), ...browser }));

vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ completeLogin }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { LocalAuthError } from "../../lib/local-auth-api";
import { readLinkToken, SetPasswordForm } from "./set-password-form";

const TOKEN = "a".repeat(43);
const GOOD = "purple elephants dance quietly";

function openWithHash(hash: string) {
  window.history.replaceState(null, "", `/auth/setup${hash}`);
}

async function fill(password: string, confirm = password) {
  fireEvent.change(await screen.findByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Type the password again"), { target: { value: confirm } });
}

beforeEach(() => openWithHash(`#token=${TOKEN}`));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("readLinkToken", () => {
  it("reads only a well-formed token from the fragment", () => {
    expect(readLinkToken(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(readLinkToken("#token=short")).toBeNull();
    expect(readLinkToken("")).toBeNull();
  });
});

describe("SetPasswordForm", () => {
  it("removes the token from the address bar at once", async () => {
    render(<SetPasswordForm purpose="account_setup" />);
    await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");
  });

  // Strict Mode runs effects twice in development. The second run must not
  // read the fragment the first run cleared and lose the token.
  it("keeps the token under React Strict Mode", async () => {
    api.completeAccountSetup.mockResolvedValue({ accessToken: "tok-1", user: {} });
    completeLogin.mockResolvedValue(true);
    render(<StrictMode><SetPasswordForm purpose="account_setup" /></StrictMode>);
    await fill(GOOD);
    expect(screen.queryByText(/not complete/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    await waitFor(() => expect(api.completeAccountSetup).toHaveBeenCalledWith(TOKEN, GOOD));
  });

  it("explains an incomplete link", async () => {
    openWithHash("");
    render(<SetPasswordForm purpose="account_setup" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not complete/i);
  });

  it.each([
    ["a short password", "too short", "too short", /at least 15/i],
    ["two different entries", GOOD, `${GOOD}!`, /not the same/i]
  ])("refuses %s before calling the server", async (_case, password, confirm, message) => {
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(password, confirm);
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
    expect(api.completeAccountSetup).not.toHaveBeenCalled();
  });

  it("account setup starts the session and opens the workspace", async () => {
    api.completeAccountSetup.mockResolvedValue({ accessToken: "tok-1", user: {} });
    completeLogin.mockResolvedValue(true);
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(GOOD);
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(api.completeAccountSetup).toHaveBeenCalledWith(TOKEN, GOOD);
  });

  it("account setup under a required policy enrols an authenticator before the workspace opens", async () => {
    api.fetchAuthConfig.mockResolvedValue({ mode: "jwt", loginTypes: ["local"], passwordRecovery: false, passkeys: false });
    api.completeAccountSetup.mockResolvedValue({ next: "enroll" });
    api.startSignInEnrollment.mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Cogniplane:a?secret=JBSWY3DPEHPK3PXP" });
    api.confirmSignInEnrollment.mockResolvedValue({ accessToken: "tok-2", user: {}, recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
    completeLogin.mockResolvedValue(true);
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(GOOD);
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    fireEvent.click(await screen.findByRole("button", { name: "I saved my codes" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(completeLogin).toHaveBeenCalledWith("tok-2");
  });

  it("account setup offers a passkey when the config, loaded later, enables passkeys", async () => {
    let resolveConfig!: (value: unknown) => void;
    api.fetchAuthConfig.mockReturnValue(new Promise((resolve) => { resolveConfig = resolve; }));
    browser.passkeysSupported.mockReturnValue(true);
    api.completeAccountSetup.mockResolvedValue({ next: "enroll" });
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(GOOD);
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    expect(await screen.findByText("Preparing the next step…")).toBeTruthy();
    expect(api.startSignInEnrollment).not.toHaveBeenCalled();
    resolveConfig({ mode: "jwt", loginTypes: ["local"], passwordRecovery: false, passkeys: true });
    expect(await screen.findByRole("button", { name: "Add a passkey" })).toBeTruthy();
  });

  it("a reset changes the password and sends the user to sign in", async () => {
    api.completePasswordReset.mockResolvedValue(undefined);
    render(<SetPasswordForm purpose="password_reset" />);
    await fill(GOOD);
    const submit = screen.getByRole("button", { name: "Change password" });
    submit.focus();
    fireEvent.click(submit);
    expect((await screen.findByRole("status")).textContent).toMatch(/password is changed/i);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("explains a used or expired link", async () => {
    api.completeAccountSetup.mockRejectedValue(new LocalAuthError("link_invalid", 400));
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(GOOD);
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not valid any more/i);
  });
});

it.each(["account_setup", "password_reset"] as const)("replaces a terminal %s form with a safe new-link action", async purpose => {
  api.completeAccountSetup.mockRejectedValue(new LocalAuthError("link_invalid", 400));
  api.completePasswordReset.mockRejectedValue(new LocalAuthError("link_invalid", 400));
  render(<SetPasswordForm purpose={purpose} />);
  await fill(GOOD);
  const submit = screen.getByRole("button", { name: purpose === "account_setup" ? "Set password and sign in" : "Change password" });
  submit.focus();
  fireEvent.click(submit);
  await screen.findByRole("alert");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
  expect(screen.queryByLabelText("New password")).toBeNull();
  expect(screen.getByRole("link", { name: "Go to sign-in" }).getAttribute("href")).toBe("/login");
  if (purpose === "password_reset") expect(screen.getByRole("link", { name: "Get a new reset link" }).getAttribute("href")).toBe("/auth/forgot-password");
  else expect(screen.getByText(/ask your administrator for a new account setup link/i)).toBeTruthy();
  expect(completeLogin).not.toHaveBeenCalled();
});

it.each([false, "throw"])("does not resubmit the setup token after workspace loading fails: %s", async failure => {
  api.completeAccountSetup.mockResolvedValue({ accessToken: "synthetic-consumed", user: {} });
  if (failure === "throw") completeLogin.mockRejectedValue(new Error("Synthetic bootstrap unavailable"));
  else completeLogin.mockResolvedValue(false);
  render(<SetPasswordForm purpose="account_setup" />);
  await fill(GOOD);
  const submit = screen.getByRole("button", { name: "Set password and sign in" });
  submit.focus();
  fireEvent.click(submit);
  expect((await screen.findByRole("alert")).textContent).toContain("Sign-in completed, but your workspace details could not load.");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workspace did not load");
  expect(screen.getByText(/password is saved.*setup link has been used/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reload the page" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
  expect(screen.queryByLabelText("New password")).toBeNull();
  expect(screen.getByRole("link", { name: "Go to sign-in" }).getAttribute("href")).toBe("/login");
  expect(api.completeAccountSetup).toHaveBeenCalledTimes(1);
  expect(completeLogin).toHaveBeenCalledExactlyOnceWith("synthetic-consumed");
});

it("keeps a network failure retryable without marking a password as invalid", async () => {
  api.completePasswordReset.mockRejectedValueOnce(new LocalAuthError("network_error", 503)).mockResolvedValueOnce(undefined);
  render(<SetPasswordForm purpose="password_reset" />);
  await fill(GOOD);
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  const error = await screen.findByRole("alert");
  const button = screen.getByRole("button", { name: "Change password" });
  expect(button.getAttribute("aria-describedby")).toBe(error.id);
  expect(button.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByLabelText("New password").getAttribute("aria-invalid")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await screen.findByRole("link", { name: "Sign in" });
  expect(api.completePasswordReset).toHaveBeenCalledTimes(2);
  expect(completeLogin).not.toHaveBeenCalled();
});

describe("field and request feedback", () => {
  it("puts a short password error under New password and moves focus there", async () => {
    render(<SetPasswordForm purpose="account_setup" />);
    await fill("too short");
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    const alert = await screen.findByRole("alert");
    const password = screen.getByLabelText("New password");
    const confirm = screen.getByLabelText("Type the password again");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(password.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(confirm.getAttribute("aria-invalid")).toBeNull();
    expect(confirm.getAttribute("aria-describedby")).toBeNull();
    expect(alert.closest("div")?.contains(password)).toBe(true);
    expect(document.activeElement).toBe(password);
  });

  it("puts a mismatch under the confirmation and moves focus there", async () => {
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(GOOD, `${GOOD}!`);
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));
    const alert = await screen.findByRole("alert");
    const password = screen.getByLabelText("New password");
    const confirm = screen.getByLabelText("Type the password again");
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toBe(alert.id);
    expect(password.getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(confirm);
  });

  it("puts a server password rule under New password, keeps entries and keeps focus on the submit", async () => {
    let reject!: (error: Error) => void;
    api.completeAccountSetup.mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
    render(<SetPasswordForm purpose="account_setup" />);
    await fill(GOOD);
    const submit = screen.getByRole("button", { name: "Set password and sign in" });
    const password = screen.getByLabelText("New password") as HTMLInputElement;
    const scrollIntoView = vi.fn();
    password.scrollIntoView = scrollIntoView;
    submit.focus();
    fireEvent.click(submit);
    expect(password.readOnly).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(submit);
    fireEvent.submit(password.closest("form")!);
    expect(api.completeAccountSetup).toHaveBeenCalledTimes(1);
    reject(new LocalAuthError("password_too_common", 400));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/too common/i);
    expect(password.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(password.value).toBe(GOOD);
    expect(document.activeElement).toBe(submit);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" }));
  });

  it("shows and hides each new password without changing its value, autocomplete or name", async () => {
    render(<SetPasswordForm purpose="password_reset" />);
    await fill(GOOD);
    const password = screen.getByLabelText("New password") as HTMLInputElement;
    const show = screen.getByRole("button", { name: "Show new password" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(password.type).toBe("text");
    expect(show.getAttribute("aria-pressed")).toBe("true");
    expect(password.value).toBe(GOOD);
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(password.getAttribute("spellcheck")).toBe("false");
    fireEvent.click(show);
    expect(password.type).toBe("password");
    expect((screen.getByLabelText("Type the password again") as HTMLInputElement).type).toBe("password");
    expect(screen.getByRole("button", { name: "Show the password typed again" })).toBeTruthy();
  });
});
