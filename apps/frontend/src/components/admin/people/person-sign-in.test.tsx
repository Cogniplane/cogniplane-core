// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@cogniplane/shared-types";

const api = vi.hoisted(() => ({
  stepUp: vi.fn(), resetMemberPassword: vi.fn(), disableMember: vi.fn(), enableMember: vi.fn(), signOutMember: vi.fn(),
  resetMemberMfa: vi.fn(), fetchMySecurity: vi.fn(), fetchAuthConfig: vi.fn(), resendMemberLink: vi.fn()
}));
const SECURITY = { loginType: "local", passwordChangedAt: null, totpEnabled: false, recoveryCodesRemaining: 0, mfaRequired: false };

/** The confirm button stays off until the dialog knows which proof to ask for. */
async function confirmButton(dialog: HTMLElement, name: string): Promise<HTMLButtonElement> {
  const button = within(dialog).getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}
vi.mock("../../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { PersonSignIn } from "./person-sign-in";

function person(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    userId: "dana", tenantId: "t", email: "dana@example.test", displayName: "Dana", role: "member",
    isBetaTester: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    accountStatus: "active", ...overrides
  };
}

const OWNER = { userId: "owner", role: "owner" as const };

function renderSection(target: AdminUser, actor = OWNER) {
  const onStatus = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PersonSignIn person={target} actor={actor} onStatus={onStatus} /></QueryClientProvider>);
  return { onStatus };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("PersonSignIn", () => {
  it("renders nothing for a WorkOS member", () => {
    renderSection(person({ accountStatus: null }));
    expect(screen.queryByRole("region", { name: "Sign-in" })).toBeNull();
  });

  it("shows the reason instead of actions when the actor may not act", () => {
    renderSection(person({ role: "admin" }), { userId: "admin", role: "admin" as never });
    expect(screen.getByText(/only owners can manage an admin/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reset password/i })).toBeNull();
  });

  it("reset password: confirms the manager's password, then shows the one-time link", async () => {
    api.stepUp.mockResolvedValue("step-up-token");
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    api.resetMemberPassword.mockResolvedValue({
      link: { url: "https://app.test/auth/reset-password#token=x", expiresAt: "2026-10-27T10:00:00.000Z", purpose: "password_reset" },
      email: null
    });
    renderSection(person());

    fireEvent.click(screen.getByRole("button", { name: "Reset password…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "manager password" } });
    fireEvent.click(await confirmButton(dialog, "Get the link"));

    await waitFor(() => expect(api.resetMemberPassword).toHaveBeenCalledWith("dana", "step-up-token"));
    expect(api.stepUp).toHaveBeenCalledWith("member.password_reset", { password: "manager password" });
    expect((await screen.findByLabelText("One-time link") as HTMLInputElement).value).toContain("#token=x");
  });

  it("a wrong manager password keeps the dialog open with the reason", async () => {
    const { LocalAuthError } = await import("../../../lib/local-auth-api");
    api.stepUp.mockRejectedValue(new LocalAuthError("invalid_credentials", 403));
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    renderSection(person());
    fireEvent.click(screen.getByRole("button", { name: "Disable account…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "wrong" } });
    fireEvent.click(await confirmButton(dialog, "Disable account"));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/not correct/i);
    expect(api.disableMember).not.toHaveBeenCalled();
  });

  // Enable makes the account's password work again: it needs step-up.
  it("a disabled account offers Enable, with the manager's proof, and no reset", async () => {
    api.stepUp.mockResolvedValue("step-up-token");
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    api.enableMember.mockResolvedValue("active");
    const { onStatus } = renderSection(person({ accountStatus: "disabled" }));
    expect(screen.queryByRole("button", { name: /reset password/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enable account…" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.enableMember).not.toHaveBeenCalled();
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "manager password" } });
    fireEvent.click(await confirmButton(dialog, "Enable account"));

    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("Dana can sign in again."));
    expect(api.enableMember).toHaveBeenCalledWith("dana", "step-up-token");
    expect(api.stepUp).toHaveBeenCalledWith("member.enable", { password: "manager password" });
  });

  it("shows the two-step state, and offers a reset only when it is on", () => {
    renderSection(person({ mfaEnabled: false }));
    expect(screen.getByText("Two-step verification: off.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reset two-step/i })).toBeNull();
  });

  it("reset two-step verification: a manager with an authenticator confirms with a code", async () => {
    api.stepUp.mockResolvedValue("step-up-token");
    api.fetchMySecurity.mockResolvedValue({ ...SECURITY, totpEnabled: true, recoveryCodesRemaining: 10 });
    api.resetMemberMfa.mockResolvedValue(undefined);
    const { onStatus } = renderSection(person({ mfaEnabled: true }));

    fireEvent.click(screen.getByRole("button", { name: "Reset two-step verification…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Code from your authenticator app"), { target: { value: " 123456 " } });
    fireEvent.click(await confirmButton(dialog, "Reset"));

    await waitFor(() => expect(api.resetMemberMfa).toHaveBeenCalledWith("dana", "step-up-token"));
    expect(api.stepUp).toHaveBeenCalledWith("member.mfa_reset", { totpCode: "123456" });
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("Dana must set up two-step verification at their next sign-in."));
  });
});

describe("PersonSignIn with email on", () => {
  const EMAIL_ON = { mode: "jwt", loginTypes: ["local"], passwordRecovery: true, passkeys: false };

  it("a reset emails the link: the manager sees where it went, never the link", async () => {
    api.fetchAuthConfig.mockResolvedValue(EMAIL_ON);
    api.stepUp.mockResolvedValue("step-up-token");
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    api.resetMemberPassword.mockResolvedValue({
      link: null, email: { to: "dana@example.test", expiresAt: "2026-10-27T10:00:00.000Z", purpose: "password_reset" }
    });
    renderSection(person());

    fireEvent.click(screen.getByRole("button", { name: "Reset password…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/we email them a one-time link/i)).toBeTruthy());
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "manager password" } });
    fireEvent.click(await confirmButton(dialog, "Send the link"));

    expect(await screen.findByText(/we emailed a one-time link to dana@example.test/i)).toBeTruthy();
    expect(screen.queryByLabelText("One-time link")).toBeNull();
  });

  it("shows the latest link email and sends it again", async () => {
    api.fetchAuthConfig.mockResolvedValue(EMAIL_ON);
    api.resendMemberLink.mockResolvedValue({ to: "dana@example.test", expiresAt: "2026-10-29T10:00:00.000Z", purpose: "account_setup" });
    const { onStatus } = renderSection(person({
      accountStatus: "pending_setup",
      linkEmail: { purpose: "account_setup", status: "failed", updatedAt: "2026-10-26T10:00:00.000Z", error: "EENVELOPE 550" }
    }));
    expect(screen.getByText("The setup link email could not be sent: the mail server refused the address.")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Send the link again" }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.stringMatching(/^We emailed a new link to dana@example.test\. It ends /)));
    expect(api.resendMemberLink).toHaveBeenCalledWith("dana");
  });

  it("offers no resend without email, nor for an active account whose last email went out", async () => {
    api.fetchAuthConfig.mockResolvedValue({ ...EMAIL_ON, passwordRecovery: false });
    renderSection(person({ accountStatus: "pending_setup" }));
    await waitFor(() => expect(api.fetchAuthConfig).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Send the link again" })).toBeNull();
    cleanup();

    api.fetchAuthConfig.mockResolvedValue(EMAIL_ON);
    renderSection(person({ linkEmail: { purpose: "password_reset", status: "sent", updatedAt: "2026-10-26T10:00:00.000Z", error: null } }));
    expect(await screen.findByText(/the password reset link email went out/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send the link again" })).toBeNull();
  });
});
