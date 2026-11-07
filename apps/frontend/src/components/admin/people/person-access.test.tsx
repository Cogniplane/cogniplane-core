// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUser } from "@cogniplane/shared-types";

const push = vi.hoisted(() => vi.fn());
const admin = vi.hoisted(() => ({ removeMember: vi.fn(), changeMemberRole: vi.fn(), setUserBetaTester: vi.fn() }));
const localApi = vi.hoisted(() => ({ stepUp: vi.fn(), fetchMySecurity: vi.fn() }));
const SECURITY = { loginType: "local", passwordChangedAt: null, totpEnabled: false, recoveryCodesRemaining: 0, mfaRequired: false };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("../../../lib/admin-api", () => admin);
vi.mock("../../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/local-auth-api")>();
  return { ...actual, ...localApi };
});

import { ApiError } from "../../../lib/api-client";
import { PersonAccess } from "./person-access";

function person(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    userId: "dana", tenantId: "t", email: "dana@example.test", displayName: "Dana", role: "member",
    isBetaTester: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function renderAccess(target: AdminUser) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><PersonAccess person={target} actor={{ userId: "owner", role: "owner" }} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("PersonAccess removal", () => {
  it("removes a local account only with the manager's step-up proof", async () => {
    localApi.stepUp.mockResolvedValue("step-up-token");
    localApi.fetchMySecurity.mockResolvedValue(SECURITY);
    admin.removeMember.mockResolvedValue(undefined);
    renderAccess(person({ accountStatus: "active" }));

    fireEvent.click(screen.getByRole("button", { name: /remove from organization/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "manager password" } });
    const confirm = within(dialog).getByRole("button", { name: "Remove from organization" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() => expect(admin.removeMember).toHaveBeenCalledWith("dana", "step-up-token"));
    expect(localApi.stepUp).toHaveBeenCalledWith("member.remove", { password: "manager password" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/users"));
  });

  it("removes a WorkOS member with the plain confirmation, no password", async () => {
    renderAccess(person({ accountStatus: null }));
    fireEvent.click(screen.getByRole("button", { name: /remove from organization/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByLabelText("Your password")).toBeNull();
  });
});

describe("PersonAccess role change", () => {
  async function pickRole(label: string, confirmName: string) {
    fireEvent.click(screen.getByRole("button", { name: "Change role" }));
    const roleDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(roleDialog).getByRole("radio", { name: new RegExp(`^${label}`) }));
    fireEvent.click(within(roleDialog).getByRole("button", { name: "Continue" }));
    fireEvent.click(await within(roleDialog).findByRole("button", { name: confirmName }));
  }

  // An access token alone must not make an account an owner: the backend
  // needs the manager's step-up for member.role_change on a local account.
  it("changes a local account's role only with the manager's step-up proof", async () => {
    localApi.stepUp.mockResolvedValue("step-up-token");
    localApi.fetchMySecurity.mockResolvedValue(SECURITY);
    admin.changeMemberRole.mockResolvedValue(undefined);
    renderAccess(person({ accountStatus: "active" }));

    await pickRole("Owner", "Make owner");
    expect(admin.changeMemberRole).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Make Dana an owner?" });
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "manager password" } });
    const confirm = within(dialog).getByRole("button", { name: "Make owner" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() => expect(admin.changeMemberRole).toHaveBeenCalledWith("dana", "owner", "step-up-token"));
    expect(localApi.stepUp).toHaveBeenCalledWith("member.role_change", { password: "manager password" });
    expect(await screen.findByText("Role changed to owner.")).toBeTruthy();
  });

  it("shows a refusal that is not about the proof in the role dialog", async () => {
    localApi.stepUp.mockResolvedValue("step-up-token");
    localApi.fetchMySecurity.mockResolvedValue(SECURITY);
    admin.changeMemberRole.mockRejectedValue(new ApiError({
      status: 409, code: "account_not_active", method: "PUT", path: "/tenant/members/dana/role", message: "account_not_active"
    }));
    renderAccess(person({ accountStatus: "active" }));

    await pickRole("Owner", "Make owner");
    const dialog = await screen.findByRole("dialog", { name: "Make Dana an owner?" });
    fireEvent.change(await within(dialog).findByLabelText("Your password"), { target: { value: "manager password" } });
    const confirm = within(dialog).getByRole("button", { name: "Make owner" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    const roleDialog = await screen.findByRole("alertdialog");
    expect((await within(roleDialog).findByRole("alert")).textContent).toBe("Only a person with an active account can become an owner.");
  });

  it("changes a WorkOS member's role with the plain confirmation, no password", async () => {
    admin.changeMemberRole.mockResolvedValue(undefined);
    renderAccess(person({ accountStatus: null }));

    await pickRole("Admin", "Change to admin");

    await waitFor(() => expect(admin.changeMemberRole).toHaveBeenCalledWith("dana", "admin"));
    expect(localApi.stepUp).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Your password")).toBeNull();
  });
});
