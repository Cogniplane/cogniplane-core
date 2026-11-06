// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeLogin = vi.hoisted(() => vi.fn());
const adoptSession = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  fetchMySecurity: vi.fn(), changeMyPassword: vi.fn(), stepUp: vi.fn(), startMyTotp: vi.fn(), confirmMyTotp: vi.fn(),
  removeMyTotp: vi.fn(), regenerateMyRecoveryCodes: vi.fn(), signOutEverywhere: vi.fn(), fetchAuthConfig: vi.fn(),
  listMyPasskeys: vi.fn(), addMyPasskey: vi.fn(), renameMyPasskey: vi.fn(), removeMyPasskey: vi.fn()
}));
const browser = vi.hoisted(() => ({ passkeysSupported: vi.fn(() => true) }));
vi.mock("../lib/passkey-browser", async (importOriginal) => ({ ...(await importOriginal<object>()), ...browser }));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ completeLogin, adoptSession, logout: vi.fn() }) }));
vi.mock("../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { SecuritySection } from "./security-section";
import { ApiError } from "../lib/api-client";
import { queryKeys } from "../lib/query-keys";

const OFF = { loginType: "local", passwordChangedAt: null, totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: false };
const CONFIG = { mode: "jwt", loginTypes: ["local"], passwordRecovery: false, passkeys: true };
const PASSKEY = { id: "cred-1", name: "Laptop", createdAt: "2026-10-01T00:00:00.000Z", lastUsedAt: null, backedUp: true };
const ON = { ...OFF, totpEnabled: true, recoveryCodesRemaining: 9 };
const ENROLLMENT = { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Cogniplane:a?secret=JBSWY3DPEHPK3PXP" };
const GOOD = "purple elephants dance quietly";

async function addPasskeyWhenReady() {
  const button = await screen.findByRole("button", { name: "Add a passkey" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}

const clients: QueryClient[] = [];
function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><SecuritySection /></QueryClientProvider>);
  return client;
}

async function confirmIn(dialog: HTMLElement, name: string) {
  const button = within(dialog).getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

beforeEach(() => {
  api.fetchAuthConfig.mockResolvedValue({ ...CONFIG, passkeys: false });
  api.listMyPasskeys.mockResolvedValue([]);
  browser.passkeysSupported.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.resetAllMocks();
});

describe("SecuritySection, two-step verification", () => {
  it("a first authenticator needs the password first, then starts the new session and shows the recovery codes", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.stepUp.mockResolvedValue("step-up-token");
    api.startMyTotp.mockResolvedValue(ENROLLMENT);
    api.confirmMyTotp.mockResolvedValue({ accessToken: "tok-new", user: {}, recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
    // Without a factor, the step-up asks for the password.
    const dialog = await screen.findByRole("dialog");
    expect(api.startMyTotp).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "my own password" } });
    await confirmIn(dialog, "Continue");

    fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "123456" } });
    expect(api.stepUp).toHaveBeenCalledWith("self.totp_replace", { password: "my own password" });
    expect(api.startMyTotp).toHaveBeenCalledWith("step-up-token");
    fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));

    expect((await screen.findByRole("list", { name: "Recovery codes" })).textContent).toContain("AAAA-BBBB-CCCC-DDDD");
    // The new session starts with the codes. It does not load the account
    // again, so a failed load cannot leave the page and lose the codes.
    expect(adoptSession).toHaveBeenCalledWith("tok-new", {});
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
    expect(await screen.findByText("Your authenticator app is set up.")).toBeTruthy();
    // Saving the codes does not install the older enrolment token again.
    expect(adoptSession).toHaveBeenCalledTimes(1);
    expect(completeLogin).not.toHaveBeenCalled();
    expect(api.startMyTotp).toHaveBeenCalledTimes(1);
  });

  it("a new phone needs a code from the current app first", async () => {
    api.fetchMySecurity.mockResolvedValue(ON);
    api.stepUp.mockResolvedValue("step-up-token");
    api.startMyTotp.mockResolvedValue(ENROLLMENT);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Use a new phone…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    await confirmIn(dialog, "Continue");

    await screen.findByLabelText("Code from the app");
    expect(api.stepUp).toHaveBeenCalledWith("self.totp_replace", { totpCode: "123456" });
    expect(api.startMyTotp).toHaveBeenCalledWith("step-up-token");
  });

  it("a required policy blocks turning it off", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...ON, mfaRequired: true });
    renderSection();
    const off = await screen.findByRole("button", { name: "Turn off…" });
    expect((off as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/requires two-step verification/i)).toBeTruthy();
  });

  it("turning it off spends a step-up and starts the new session", async () => {
    api.fetchMySecurity.mockResolvedValue(ON);
    api.stepUp.mockResolvedValue("step-up-token");
    api.removeMyTotp.mockResolvedValue({ accessToken: "tok-off", user: {} });
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Turn off…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    await confirmIn(dialog, "Turn off");

    await waitFor(() => expect(api.removeMyTotp).toHaveBeenCalledWith("step-up-token"));
    expect(completeLogin).toHaveBeenCalledWith("tok-off");
  });
});

describe("SecuritySection, password change", () => {
  async function fillPassword() {
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "old password here!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
  }

  it("with an authenticator, asks for a code before the change", async () => {
    api.fetchMySecurity.mockResolvedValue(ON);
    api.stepUp.mockResolvedValue("step-up-token");
    api.changeMyPassword.mockResolvedValue({ accessToken: "tok-pw", user: {} });
    renderSection();
    await screen.findByRole("button", { name: "Turn off…" });
    await fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    const dialog = await screen.findByRole("dialog");
    expect(api.changeMyPassword).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    await confirmIn(dialog, "Change password");

    await waitFor(() => expect(api.changeMyPassword).toHaveBeenCalledWith("old password here!", GOOD, "step-up-token"));
    expect(api.stepUp).toHaveBeenCalledWith("self.password_change", { totpCode: "123456" });
  });

  it("without an authenticator, changes at once", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.changeMyPassword.mockResolvedValue({ accessToken: "tok-pw", user: {} });
    renderSection();
    await screen.findByRole("button", { name: "Set up an authenticator app" });
    await fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(api.changeMyPassword).toHaveBeenCalledWith("old password here!", GOOD, undefined));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("SecuritySection, passkeys", () => {
  beforeEach(() => {
    api.fetchAuthConfig.mockResolvedValue(CONFIG);
  });

  it("a first passkey needs the password first, and starts the new session with its recovery codes", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.stepUp.mockResolvedValue("step-up-token");
    api.addMyPasskey.mockResolvedValue({ passkey: PASSKEY, accessToken: "tok-pk", user: {}, recoveryCodes: ["AAAA-BBBB-CCCC-DDDD"] });
    renderSection();

    fireEvent.change(await screen.findByLabelText("Name (optional)"), { target: { value: "Laptop" } });
    await addPasskeyWhenReady();
    // Without a factor, the step-up asks for the password.
    const dialog = await screen.findByRole("dialog");
    expect(api.addMyPasskey).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "my own password" } });
    await confirmIn(dialog, "Continue");

    expect((await screen.findByRole("list", { name: "Recovery codes" })).textContent).toContain("AAAA-BBBB-CCCC-DDDD");
    expect(api.stepUp).toHaveBeenCalledWith("self.passkey_add", { password: "my own password" });
    expect(api.addMyPasskey).toHaveBeenCalledWith("Laptop", "step-up-token");
    expect(adoptSession).toHaveBeenCalledWith("tok-pk", {});
    fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
    expect(await screen.findByText("Your passkey is added.")).toBeTruthy();
    expect(adoptSession).toHaveBeenCalledTimes(1);
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("a first passkey that fails after the step-up keeps the dialog open with the error", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.stepUp.mockResolvedValue("step-up-token");
    api.addMyPasskey.mockRejectedValue(new Error("cancelled"));
    renderSection();

    await addPasskeyWhenReady();
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "my own password" } });
    await confirmIn(dialog, "Continue");

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("with a factor already, adding a passkey asks for the second step first", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...OFF, passkeyCount: 1, recoveryCodesRemaining: 10 });
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    api.stepUp.mockResolvedValue("step-up-token");
    api.addMyPasskey.mockResolvedValue({ passkey: { ...PASSKEY, id: "cred-2" } });
    renderSection();

    await addPasskeyWhenReady();
    const dialog = await screen.findByRole("dialog");
    // Only passkeys: nothing to type, the confirm button uses a passkey.
    expect(within(dialog).queryByLabelText("Your password")).toBeNull();
    await confirmIn(dialog, "Continue");

    await waitFor(() => expect(api.addMyPasskey).toHaveBeenCalledWith(expect.any(String), "step-up-token"));
    expect(api.stepUp).toHaveBeenCalledWith("self.passkey_add", { passkey: true });
    expect(completeLogin).not.toHaveBeenCalled();
    expect(adoptSession).not.toHaveBeenCalled();
  });

  it("the only passkey under a required policy cannot be removed", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...OFF, passkeyCount: 1, mfaRequired: true });
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    renderSection();
    const list = await screen.findByRole("list", { name: "Your passkeys" });
    expect((within(list).getByRole("button", { name: "Remove…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("removing a passkey spends a step-up and starts the new session", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...ON, passkeyCount: 1 });
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    api.stepUp.mockResolvedValue("step-up-token");
    api.removeMyPasskey.mockResolvedValue({ accessToken: "tok-rm", user: {} });
    renderSection();

    const list = await screen.findByRole("list", { name: "Your passkeys" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    await confirmIn(dialog, "Remove");

    await waitFor(() => expect(api.removeMyPasskey).toHaveBeenCalledWith("cred-1", "step-up-token"));
    expect(completeLogin).toHaveBeenCalledWith("tok-rm");
  });

  it("with a passkey left, the authenticator app can be turned off under a required policy", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...ON, passkeyCount: 1, mfaRequired: true });
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    renderSection();
    expect(((await screen.findByRole("button", { name: "Turn off…" })) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an authenticator app added next to a passkey needs a step-up", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...OFF, passkeyCount: 1, recoveryCodesRemaining: 10 });
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(api.startMyTotp).not.toHaveBeenCalled();
  });

});

// Bead q4w0.13: each change that ends the account's sessions also stops its
// running agent turns. The confirmation says so before the user confirms.
describe("SecuritySection, running agent work", () => {
  const STOPS = "Running agent work stops.";
  const dialogText = async () => (await screen.findByRole("dialog")).textContent ?? "";

  it("the password form says so, and so does its step-up", async () => {
    api.fetchMySecurity.mockResolvedValue(ON);
    renderSection();
    expect(await screen.findByText("A new password signs you out on every other device. Running agent work stops.")).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Current password"), { target: { value: "old password here!" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await dialogText()).toContain(STOPS);
  });

  it("setting up and turning off the authenticator app say so", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
    expect(await dialogText()).toContain(STOPS);
    cleanup();

    api.fetchMySecurity.mockResolvedValue(ON);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Turn off…" }));
    expect(await dialogText()).toContain(STOPS);
  });

  it("a first passkey and a passkey removal say so; a further passkey changes no session and does not", async () => {
    api.fetchAuthConfig.mockResolvedValue(CONFIG);
    api.fetchMySecurity.mockResolvedValue(OFF);
    renderSection();
    await addPasskeyWhenReady();
    expect(await dialogText()).toContain(STOPS);
    cleanup();

    api.fetchMySecurity.mockResolvedValue({ ...ON, passkeyCount: 1 });
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    renderSection();
    await addPasskeyWhenReady();
    expect(await dialogText()).not.toContain(STOPS);
    cleanup();

    renderSection();
    const list = await screen.findByRole("list", { name: "Your passkeys" });
    fireEvent.click(within(list).getByRole("button", { name: "Remove…" }));
    expect(await dialogText()).toContain(STOPS);
  });

  it("sign out everywhere says so", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere…" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain(STOPS);
  });
});

describe("SecuritySection, password feedback", () => {
  it.each([
    ["short", "short", "New password"],
    [GOOD, `${GOOD}!`, "Type the new password again"]
  ])("binds validation to its field for %s", async (next, confirm, fieldName) => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    renderSection();
    const button = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: confirm } });
    fireEvent.click(button);
    const error = await screen.findByRole("alert");
    const field = screen.getByLabelText(fieldName);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(api.changeMyPassword).not.toHaveBeenCalled();
  });

  it("keeps pending focus, guards repeat submits and removes the old request error on retry", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    let reject!: (error: Error) => void;
    api.changeMyPassword.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    renderSection();
    const button = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit((button as HTMLButtonElement).form!);
    expect(api.changeMyPassword).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByLabelText("New password") as HTMLInputElement).readOnly).toBe(true);
    expect(document.activeElement).toBe(button);
    reject(new Error("Synthetic failure"));
    await screen.findByRole("alert");
    fireEvent.click(button);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(api.changeMyPassword).toHaveBeenCalledTimes(2);
    const field = screen.getByLabelText("Current password");
    field.focus();
    reject(new Error("Synthetic retry failure"));
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(field);
  });

  it.each([
    ["invalid_credentials", "Current password", "Your current password is not correct. Try again."],
    ["password_too_short", "New password", "Use at least 15 characters."],
    ["password_too_long", "New password", "Use at most 128 characters."],
    ["password_too_common", "New password", "This password is too common. Choose another one."],
    ["password_contains_email", "New password", "Do not use your email address in your password."]
  ])("routes server %s to %s without taking focus from the submit button", async (code, fieldName, message) => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.changeMyPassword.mockRejectedValue(new ApiError({ code, status: code === "invalid_credentials" ? 403 : 400, method: "POST", path: "/me/security/password", message: code }));
    renderSection();
    const button = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    button.focus();
    fireEvent.click(button);
    const error = await screen.findByRole("alert");
    const field = screen.getByLabelText(fieldName);
    expect(error.textContent).toBe(message);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(field.parentElement?.contains(error)).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(api.changeMyPassword).toHaveBeenCalledTimes(1);
    expect(completeLogin).not.toHaveBeenCalled();
    api.changeMyPassword.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(button);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(field.getAttribute("aria-describedby")).toBeNull();
    expect(api.changeMyPassword).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["invalid_credentials", "Current password", "Your current password is not correct. Try again."],
    ["password_too_short", "New password", "Use at least 15 characters."],
    ["password_too_long", "New password", "Use at most 128 characters."],
    ["password_too_common", "New password", "This password is too common. Choose another one."],
    ["password_contains_email", "New password", "Do not use your email address in your password."]
  ])("returns from second-factor confirmation to the field for %s", async (code, fieldName, message) => {
    api.fetchMySecurity.mockResolvedValue(ON);
    api.stepUp.mockResolvedValue("synthetic-step-up");
    api.changeMyPassword.mockRejectedValue(new ApiError({ code, status: code === "invalid_credentials" ? 403 : 400, method: "POST", path: "/me/security/password", message: code }));
    renderSection();
    const opener = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((opener as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    const confirmButton = within(dialog).getByRole("button", { name: "Change password" });
    confirmButton.focus();
    await confirmIn(dialog, "Change password");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const field = screen.getByLabelText(fieldName);
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(message);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(api.changeMyPassword).toHaveBeenCalledWith("sample old password", GOOD, "synthetic-step-up");
    expect(completeLogin).not.toHaveBeenCalled();
    expect(screen.queryByText(/Your password is changed/)).toBeNull();
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe(GOOD);
    fireEvent.click(opener);
    const retryDialog = await screen.findByRole("dialog");
    expect(within(retryDialog).queryByRole("alert")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("returns a passkey-confirmed password field error to the password form", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...OFF, passkeyCount: 1 });
    api.stepUp.mockResolvedValue("synthetic-passkey-proof");
    api.changeMyPassword.mockRejectedValue(new ApiError({ code: "invalid_credentials", status: 403, method: "POST", path: "/me/security/password", message: "invalid_credentials" }));
    renderSection();
    const opener = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((opener as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "Change password" });
    button.focus();
    await confirmIn(dialog, "Change password");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.stepUp).toHaveBeenCalledWith("self.password_change", { passkey: true });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Your current password is not correct. Try again.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Current password")));
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it("keeps a general password failure in the second-factor dialog for retry", async () => {
    api.fetchMySecurity.mockResolvedValue(ON);
    api.stepUp.mockResolvedValue("synthetic-step-up");
    api.changeMyPassword.mockRejectedValue(new ApiError({ code: "sample_unavailable", status: 503, method: "POST", path: "/me/security/password", message: "Sample unavailable" }));
    renderSection();
    const opener = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((opener as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    await confirmIn(dialog, "Change password");
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(completeLogin).not.toHaveBeenCalled();
    let finishChange!: (value: { accessToken: string }) => void;
    api.changeMyPassword.mockImplementationOnce(() => new Promise(resolve => { finishChange = resolve; }));
    await confirmIn(dialog, "Change password");
    await waitFor(() => expect(api.changeMyPassword).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByRole("alert", { hidden: true })).toHaveLength(0);
    finishChange({ accessToken: "synthetic-replacement" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(completeLogin).toHaveBeenCalledExactlyOnceWith("synthetic-replacement");
    expect(await screen.findByText(/Your password is changed/)).toBeTruthy();
    expect(screen.queryAllByRole("alert", { hidden: true })).toHaveLength(0);
  });

  it("keeps a failed request after its action and binds the error to that action", async () => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.changeMyPassword.mockRejectedValue(new Error("Synthetic password failure"));
    renderSection();
    const button = await screen.findByRole("button", { name: "Change password" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "sample old password" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
    fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
    button.focus();
    fireEvent.click(button);
    const error = await screen.findByRole("alert");
    expect(error.id).not.toBe("");
    expect(button.getAttribute("aria-describedby")).toBe(error.id);
    expect(button.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(api.changeMyPassword).toHaveBeenCalledWith("sample old password", GOOD, undefined);
    expect(completeLogin).not.toHaveBeenCalled();
  });
});

it("keeps settings enrollment visible while confirmation can replace the session", async () => {
  api.fetchMySecurity.mockResolvedValue(OFF);
  api.stepUp.mockResolvedValue("synthetic-step-up");
  api.startMyTotp.mockResolvedValue(ENROLLMENT);
  let resolve!: (value: unknown) => void;
  api.confirmMyTotp.mockReturnValue(new Promise(done => { resolve = done; }));
  renderSection();
  fireEvent.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "synthetic password" } });
  await confirmIn(dialog, "Continue");
  fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
  const cancel = screen.getByRole("button", { name: "Cancel" });
  fireEvent.click(cancel);
  expect(screen.queryByLabelText("Code from the app")).toBeTruthy();
  expect(cancel.hasAttribute("disabled")).toBe(true);
  expect(adoptSession).not.toHaveBeenCalled();
  resolve({ accessToken: "synthetic-replacement", user: {}, recoveryCodes: ["DEMO-ONLY-CODE-0001"] });
  await screen.findByRole("list", { name: "Recovery codes" });
  expect(adoptSession).toHaveBeenCalledExactlyOnceWith("synthetic-replacement", {});
  expect(completeLogin).not.toHaveBeenCalled();
});

it("nests the settings enrollment and code task headings under the section h3 and returns focus to it", async () => {
  api.fetchMySecurity.mockResolvedValue(OFF);
  api.stepUp.mockResolvedValue("synthetic-step-up");
  api.startMyTotp.mockResolvedValue(ENROLLMENT);
  api.confirmMyTotp.mockResolvedValue({ accessToken: "synthetic-replacement", user: {}, recoveryCodes: ["DEMO-ONLY-CODE-0001"] });
  renderSection();
  fireEvent.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "synthetic password" } });
  await confirmIn(dialog, "Continue");
  expect(await screen.findByRole("heading", { level: 4, name: "Set up an authenticator app" })).toBeTruthy();
  const section = await screen.findByRole("heading", { level: 3, name: "Two-step verification" });
  expect(screen.queryByRole("heading", { level: 2, name: "Set up an authenticator app" })).toBeNull();
  fireEvent.change(await screen.findByLabelText("Code from the app"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
  expect(await screen.findByRole("heading", { level: 4, name: "Save your recovery codes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "I saved my codes" }));
  await waitFor(() => expect(document.activeElement).toBe(section));
  const status = within(section.closest("section")!).getByRole("status");
  expect(status.textContent).toBe("Your authenticator app is set up.");
  expect(status.querySelector('[data-icon="success"]')).toBeTruthy();
  expect(status.querySelector('[role="status"]')).toBeNull();
});

it("returns focus to the section heading after Cancel and makes Cancel primary after a failed start", async () => {
  api.fetchMySecurity.mockResolvedValue(OFF);
  api.stepUp.mockResolvedValue("synthetic-step-up");
  api.startMyTotp.mockRejectedValue(new Error("Synthetic start failure"));
  renderSection();
  const start = await screen.findByRole("button", { name: "Set up an authenticator app" });
  const section = start.closest("section")!;
  const status = within(section).getByRole("status");
  expect(status.textContent).toBe("");
  fireEvent.click(start);
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "synthetic password" } });
  await confirmIn(dialog, "Continue");
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not start/i);
  const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
  await waitFor(() => expect(cancel.disabled).toBe(false));
  expect(api.startMyTotp).toHaveBeenCalledTimes(1);
  fireEvent.click(cancel);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Two-step verification" })));
  expect(within(section).getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Authenticator setup cancelled. Your settings have not changed.");
  expect(status.querySelector('[data-icon="success"]')).toBeNull();
  expect(status.querySelector('[role="status"]')).toBeNull();
});

it("sends a new authenticator start only after a cancelled start answers", async () => {
  api.fetchMySecurity.mockResolvedValue(OFF);
  api.stepUp.mockResolvedValue("synthetic-step-up");
  let finishFirst!: (value: typeof ENROLLMENT) => void;
  api.startMyTotp.mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; })).mockResolvedValue(ENROLLMENT);
  renderSection();
  const begin = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Set up an authenticator app" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Your password"), { target: { value: "synthetic password" } });
    await confirmIn(dialog, "Continue");
  };
  await begin();
  await waitFor(() => expect(api.startMyTotp).toHaveBeenCalledTimes(1));
  // The running start does not lock the exit.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await begin();
  await act(async () => {});
  expect(api.startMyTotp).toHaveBeenCalledTimes(1);
  await act(async () => finishFirst(ENROLLMENT));
  await waitFor(() => expect(api.startMyTotp).toHaveBeenCalledTimes(2));
});

function fillReadPassword() {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "current password" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: GOOD } });
  fireEvent.change(screen.getByLabelText("Type the new password again"), { target: { value: GOOD } });
}

describe("SecuritySection read states", () => {
  beforeEach(() => {
    api.fetchMySecurity.mockResolvedValue(OFF);
    api.fetchAuthConfig.mockResolvedValue(CONFIG);
  });

  it.each([
    { source: "security", request: api.fetchMySecurity, queryKey: queryKeys.settings.security(), label: "security details", pending: "Loading security details…", result: ON, heading: "Password" },
    { source: "config", request: api.fetchAuthConfig, queryKey: queryKeys.auth.config(), label: "passkey availability", pending: "Checking passkey availability…", result: CONFIG, heading: "Passkeys" },
    { source: "passkeys", request: api.listMyPasskeys, queryKey: queryKeys.settings.passkeys(), label: "passkey list", pending: "Loading your passkeys…", result: [PASSKEY], heading: "Passkeys" }
  ])("keeps $source pending, failed, retained and retried reads distinct", async ({ source, request, queryKey, label, pending, result, heading }) => {
    api.fetchMySecurity.mockResolvedValue(source === "passkeys" ? { ...OFF, passkeyCount: 1, mfaRequired: true } : ON);
    api.listMyPasskeys.mockResolvedValue([PASSKEY]);
    let reject!: (reason: Error) => void;
    request.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const client = renderSection();
    expect(await screen.findByText(pending)).toBeTruthy();
    if (source === "security") {
      expect(screen.queryByText(/^Off\./)).toBeNull();
      expect(screen.queryByRole("button", { name: "Set up an authenticator app" })).toBeNull();
      fillReadPassword();
      fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
      expect((screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => { reject(new Error("read failed")); });
    const retry = await screen.findByRole("button", { name: `Retry ${label}` });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    if (source === "security") {
      fillReadPassword();
      fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
    } else if (source === "config") {
      expect(screen.queryByText("Passkeys are disabled for this installation.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    } else expect(screen.queryByText("You have no passkeys yet.")).toBeNull();
    const otherReads = [api.fetchMySecurity, api.fetchAuthConfig, api.listMyPasskeys].filter(read => read !== request);
    // Security and config must both load before the passkey list can start.
    const independentReads = source === "passkeys" ? otherReads : [source === "config" ? api.fetchMySecurity : api.fetchAuthConfig];
    const calls = independentReads.map(read => read.mock.calls.length);
    request.mockResolvedValue(result);
    retry.focus(); fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: `Retry ${label}` })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: heading })));
    expect(independentReads.map(read => read.mock.calls.length)).toEqual(calls);
    await screen.findByRole("list", { name: "Your passkeys" });

    request.mockRejectedValue(new Error("refresh failed"));
    await act(async () => { await client.refetchQueries({ queryKey }); });
    expect(await screen.findByText(new RegExp(`Showing the last loaded ${label}`))).toBeTruthy();
    if (source === "security") {
      expect(screen.getByText(/9 recovery codes left/)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Turn off…" }) as HTMLButtonElement).disabled).toBe(true);
      fillReadPassword();
      fireEvent.submit(screen.getByLabelText("Current password").closest("form")!);
    } else {
      expect(screen.getByText(PASSKEY.name)).toBeTruthy();
      if (source === "config") expect((screen.getByRole("button", { name: "Add a passkey" }) as HTMLButtonElement).disabled).toBe(true);
      else {
        expect((screen.getByRole("button", { name: "Remove…" }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText(/cannot remove your only second step/)).toBeTruthy();
      }
    }
    const retainedRetry = screen.getByRole("button", { name: `Retry ${label}` });
    let resolve!: (value: unknown) => void;
    request.mockReturnValue(new Promise(done => { resolve = done; }));
    retainedRetry.focus(); fireEvent.click(retainedRetry);
    await waitFor(() => expect((retainedRetry as HTMLButtonElement).disabled).toBe(true));
    // A browser can move focus to the body when a focused button becomes disabled.
    document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);
    expect(retainedRetry.isConnected).toBe(true);
    await act(async () => { resolve(result); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: heading })));
    expect(api.changeMyPassword).not.toHaveBeenCalled();
    expect(api.stepUp).not.toHaveBeenCalled();
  });

  it("shows configuration pending and the confirmed installation-disabled state", async () => {
    let resolve!: (value: typeof CONFIG) => void;
    api.fetchAuthConfig.mockReturnValue(new Promise(done => { resolve = done; }));
    renderSection();
    expect(await screen.findByText("Checking passkey availability…")).toBeTruthy();
    await act(async () => { resolve({ ...CONFIG, passkeys: false }); });
    expect(await screen.findByText("Passkeys are disabled for this installation.")).toBeTruthy();
    expect(api.listMyPasskeys).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });

  it("distinguishes successful empty data and unsupported browser", async () => {
    browser.passkeysSupported.mockReturnValue(false);
    renderSection();
    expect(await screen.findByText("You have no passkeys yet.")).toBeTruthy();
    expect(screen.getByText(/^Off\./)).toBeTruthy();
    expect(screen.getByText("This browser cannot create passkeys.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });

  it("does not take focus from a field selected while Retry waits", async () => {
    api.fetchMySecurity.mockRejectedValue(new Error("failed"));
    renderSection();
    const retry = await screen.findByRole("button", { name: "Retry security details" });
    let resolve!: (value: typeof OFF) => void;
    api.fetchMySecurity.mockReturnValue(new Promise(done => { resolve = done; }));
    retry.focus();
    fireEvent.click(retry);
    const field = screen.getByLabelText("Current password");
    field.focus();
    await act(async () => { resolve(OFF); });
    await screen.findByRole("button", { name: "Set up an authenticator app" });
    expect(document.activeElement).toBe(field);
  });

  it("uses the security count for the last required factor even when a retained list disagrees", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...OFF, passkeyCount: 1, mfaRequired: true });
    api.listMyPasskeys.mockResolvedValue([PASSKEY, { ...PASSKEY, id: "other", name: "Older list entry" }]);
    renderSection();
    await screen.findByRole("list", { name: "Your passkeys" });
    for (const button of screen.getAllByRole("button", { name: "Remove…" })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/cannot remove your only second step/)).toBeTruthy();
  });
});

const A = { id: "fictional-a", name: "Laptop A", createdAt: "2026-10-01T12:00:00Z", lastUsedAt: null, backedUp: true };
const B = { ...A, id: "fictional-b", name: "Key B" };
let rows = [A, B];
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function row(name: string) { return screen.getByText(name).closest("li")!; }
function open(name: string) {
  const button = within(row(name)).getByRole("button", { name: "Rename" });
  button.focus(); fireEvent.click(button);
  return screen.getByRole("textbox", { name: "Passkey name" }) as HTMLInputElement;
}
function type(value: string) { fireEvent.change(screen.getByRole("textbox", { name: "Passkey name" }), { target: { value } }); }
function save() {
  const button = screen.getByRole("button", { name: "Save" });
  button.focus(); fireEvent.click(button);
}

describe("Passkey rename request ownership", () => {
  beforeEach(() => {
    rows = [{ ...A }, { ...B }];
    api.fetchMySecurity.mockResolvedValue({ ...ON, passkeyCount: 2, recoveryCodesRemaining: 8 });
    api.fetchAuthConfig.mockResolvedValue(CONFIG);
    api.listMyPasskeys.mockImplementation(async () => rows.map(item => ({ ...item })));
  });
  it("sends A's immutable id/name once and preserves B's later editor", async () => {
    const held = deferred();
    api.renameMyPasskey.mockImplementation(async (id, name) => { await held.promise; rows = rows.map(item => item.id === id ? { ...item, name } : item); });
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); type("A sent"); save();
    const form = screen.getByRole("textbox", { name: "Passkey name" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(api.renameMyPasskey).toHaveBeenCalledTimes(1);
    expect(api.renameMyPasskey).toHaveBeenCalledWith(A.id, "A sent");
    expect(screen.getByRole("button", { name: "Saving…" }).getAttribute("aria-busy")).toBe("true");
    const later = open(B.name); type("B later");
    await act(async () => held.resolve());
    await screen.findByText("A sent");
    expect(screen.getByRole("textbox", { name: "Passkey name" })).toBe(later);
    expect(later.value).toBe("B later");
    expect(document.activeElement).toBe(later);
  });

  it("keeps edits typed in A while A's earlier name is pending", async () => {
    const held = deferred(); api.renameMyPasskey.mockReturnValue(held.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); const input = open(A.name); type("A sent"); save();
    input.focus(); type("A later draft");
    await act(async () => held.resolve());
    expect(input.value).toBe("A later draft");
    expect(document.activeElement).toBe(input);
    expect(api.renameMyPasskey).toHaveBeenCalledWith(A.id, "A sent");
  });

  it("keeps a reopened A editor even when its name matches the sent draft", async () => {
    const held = deferred(); api.renameMyPasskey.mockReturnValue(held.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); save();
    const cancel = screen.getByRole("button", { name: "Cancel" }); cancel.focus(); fireEvent.click(cancel);
    const reopened = open(A.name);
    await act(async () => held.resolve());
    expect(screen.getByRole("textbox", { name: "Passkey name" })).toBe(reopened);
    expect(reopened.value).toBe(A.name);
  });

  it("keeps A's failure in A's row and leaves B's draft and focus alone", async () => {
    const held = deferred(); api.renameMyPasskey.mockReturnValue(held.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); type("Rejected A"); save();
    const input = open(B.name); type("B later");
    await act(async () => held.reject(new Error("fictional failure")));
    const alert = await screen.findByRole("alert", { name: "" });
    expect(alert.closest("li")?.textContent).toContain(A.name);
    expect(alert.textContent).toContain('Could not save "Rejected A"');
    expect(input.value).toBe("B later"); expect(document.activeElement).toBe(input);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  it("allows B's independent request while A is pending and clears only the retried row's error", async () => {
    const a = deferred(); const b = deferred();
    api.renameMyPasskey.mockImplementation((id) => id === A.id ? a.promise : b.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); type("A failed"); save(); open(B.name); type("B failed"); save();
    expect(api.renameMyPasskey).toHaveBeenCalledTimes(2);
    await act(async () => { a.reject(new Error("A failure")); b.reject(new Error("B failure")); });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const retry = deferred(); api.renameMyPasskey.mockReturnValue(retry.promise); save();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("A failed");
    await act(async () => retry.resolve());
  });

  it("retains the failed draft, describes its local error and can retry it", async () => {
    api.renameMyPasskey.mockRejectedValueOnce(new Error("fictional failure")).mockResolvedValueOnce(A);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); const input = open(A.name); type("Retry this name"); save();
    const alert = await screen.findByRole("alert");
    expect(input.value).toBe("Retry this name");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    save();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Passkey name" })).toBeNull());
    expect(api.renameMyPasskey.mock.calls.map(call => call.slice(0, 2))).toEqual([[A.id, "Retry this name"], [A.id, "Retry this name"]]);
  });

  it("focuses the row's Rename control after successful save and after Cancel", async () => {
    api.renameMyPasskey.mockResolvedValue(A);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); const input = open(A.name); expect(document.activeElement).toBe(input);
    save();
    await waitFor(() => expect(document.activeElement).toBe(within(row(A.name)).getByRole("button", { name: "Rename" })));
    open(A.name);
    const cancel = screen.getByRole("button", { name: "Cancel" }); cancel.focus(); fireEvent.click(cancel);
    expect(document.activeElement).toBe(within(row(A.name)).getByRole("button", { name: "Rename" }));
  });

  it("does not take focus from a control outside the editor after save", async () => {
    const held = deferred(); api.renameMyPasskey.mockReturnValue(held.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); save();
    const outside = screen.getByLabelText("Name (optional)"); outside.focus();
    await act(async () => held.resolve());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Passkey name" })).toBeNull());
    expect(document.activeElement).toBe(outside);
  });

  it("waits for the list read before restoring focus and respects focus moved during that read", async () => {
    const held = deferred(); const read = deferred(); api.renameMyPasskey.mockReturnValue(held.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); save();
    api.listMyPasskeys.mockImplementationOnce(async () => { await read.promise; return rows; });
    await act(async () => held.resolve());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Passkey name" })).toBeNull());
    const outside = screen.getByLabelText("Name (optional)"); outside.focus();
    await act(async () => read.resolve());
    await waitFor(() => expect((within(row(A.name)).getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(false));
    expect(document.activeElement).toBe(outside);
  });

  it("blocks removal of the row with a pending rename, then restores it", async () => {
    const held = deferred(); api.renameMyPasskey.mockReturnValue(held.promise);
    renderSection(); await screen.findByRole("list", { name: "Your passkeys" }); open(A.name); save(); open(B.name);
    expect((within(row(A.name)).getByRole("button", { name: "Remove…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => held.resolve());
    await waitFor(() => expect((within(row(A.name)).getByRole("button", { name: "Remove…" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
