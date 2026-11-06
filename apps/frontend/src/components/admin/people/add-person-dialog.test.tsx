// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../../lib/api-client";

const api = vi.hoisted(() => ({ createLocalMember: vi.fn(), stepUp: vi.fn(), fetchMySecurity: vi.fn() }));
const SECURITY = { loginType: "local", passwordChangedAt: null, totpEnabled: false, recoveryCodesRemaining: 0, mfaRequired: false };
vi.mock("../../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { AddPersonButton } from "./add-person-dialog";

function openDialog(actor: { userId: string; role: "owner" | "admin" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AddPersonButton actor={actor} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  return screen.getByRole("dialog");
}

/** Fills the form and sends it; returns the step-up dialog that opens next. */
async function submitForm(dialog: HTMLElement, email: string, role?: string) {
  fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: email } });
  if (role) fireEvent.change(within(dialog).getByLabelText("Role"), { target: { value: role } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add person" }));
  return screen.findByRole("dialog", { name: /^Add .*\?$/ });
}

/** Types the manager's password in the step-up dialog and confirms. */
async function confirmWithPassword(stepUpDialog: HTMLElement) {
  fireEvent.change(await within(stepUpDialog).findByLabelText("Your password"), { target: { value: "manager password" } });
  const confirm = within(stepUpDialog).getByRole("button", { name: "Add person" }) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AddPersonButton", () => {
  it("offers an owner the member and admin roles, never owner", () => {
    const dialog = openDialog({ userId: "owner", role: "owner" });
    const options = within(within(dialog).getByLabelText("Role")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Member", "Admin"]);
  });

  // An access token alone must not create an account: the backend needs the
  // manager's step-up for member.create.
  it("asks for the manager's proof, then creates the person with the step-up token", async () => {
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    api.stepUp.mockResolvedValue("step-up-token");
    api.createLocalMember.mockResolvedValue({
      userId: "new-user", email: null,
      link: { url: "https://app.test/auth/setup#token=x", expiresAt: "2026-10-31T10:00:00.000Z", purpose: "account_setup" }
    });
    const dialog = openDialog({ userId: "owner", role: "owner" });
    const stepUpDialog = await submitForm(dialog, "new@example.test", "admin");
    expect(api.createLocalMember).not.toHaveBeenCalled();

    await confirmWithPassword(stepUpDialog);

    await waitFor(() => expect(api.createLocalMember).toHaveBeenCalledWith(
      { email: "new@example.test", displayName: undefined, role: "admin" }, "step-up-token"
    ));
    expect(api.stepUp).toHaveBeenCalledWith("member.create", { password: "manager password" });
    expect((await screen.findByLabelText("One-time link") as HTMLInputElement).value).toContain("#token=x");
  });

  it("a refused step-up stays in the step-up dialog, so the manager can try again", async () => {
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    api.stepUp.mockResolvedValue("step-up-token");
    api.createLocalMember.mockRejectedValue(
      new ApiError({ status: 403, code: "step_up_required", method: "POST", path: "/tenant/members", message: "step_up_required" })
    );
    const stepUpDialog = await submitForm(openDialog({ userId: "owner", role: "owner" }), "new@example.test");
    await confirmWithPassword(stepUpDialog);
    expect((await within(stepUpDialog).findByRole("alert")).textContent).toBe("Confirm your password again, then repeat the action.");
    expect(screen.queryByRole("dialog", { name: "Add a person" })).toBeNull();
  });

  it("shows the refusal of a new owner as a plain message, back in the form", async () => {
    // A page loaded before this rule can still ask for an owner.
    api.fetchMySecurity.mockResolvedValue(SECURITY);
    api.stepUp.mockResolvedValue("step-up-token");
    api.createLocalMember.mockRejectedValue(
      new ApiError({ status: 409, code: "account_not_active", method: "POST", path: "/tenant/members", message: "account_not_active" })
    );
    const stepUpDialog = await submitForm(openDialog({ userId: "owner", role: "owner" }), "new@example.test");
    await confirmWithPassword(stepUpDialog);
    const form = await screen.findByRole("dialog", { name: "Add a person" });
    expect((await within(form).findByRole("alert")).textContent)
      .toBe("A new person cannot be an owner. Make them an owner after they set up their account.");
    // The form keeps what the manager typed.
    expect((within(form).getByLabelText("Email") as HTMLInputElement).value).toBe("new@example.test");
  });
});
