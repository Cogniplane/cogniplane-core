// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetchTenantMfaPolicy: vi.fn(), saveTenantMfaPolicy: vi.fn(), stepUp: vi.fn(), fetchMySecurity: vi.fn() }));
vi.mock("../../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { isWeakerPolicy, TenantMfaPolicy } from "./tenant-mfa-policy";

function renderPolicy(actorRole: "owner" | "admin") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TenantMfaPolicy actorRole={actorRole} /></QueryClientProvider>);
  return client;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("isWeakerPolicy", () => {
  it("orders the rules from optional to required for everyone", () => {
    expect(isWeakerPolicy("optional", "required_for_admins")).toBe(true);
    expect(isWeakerPolicy("required_for_admins", "required_for_all")).toBe(true);
    expect(isWeakerPolicy("required_for_all", "optional")).toBe(false);
    expect(isWeakerPolicy("optional", "optional")).toBe(false);
  });
});

describe("TenantMfaPolicy", () => {
  it("an admin saves a stricter rule without a step-up", async () => {
    api.fetchTenantMfaPolicy.mockResolvedValue("optional");
    api.saveTenantMfaPolicy.mockResolvedValue("required_for_all");
    renderPolicy("admin");

    fireEvent.click(await screen.findByRole("radio", { name: /required for everyone/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    await waitFor(() => expect(api.saveTenantMfaPolicy).toHaveBeenCalledWith("required_for_all", undefined));
    expect(api.stepUp).not.toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(/saved/i);
  });

  it("an admin cannot make the rule weaker", async () => {
    api.fetchTenantMfaPolicy.mockResolvedValue("required_for_all");
    renderPolicy("admin");

    fireEvent.click(await screen.findByRole("radio", { name: /optional/i }));
    expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/only an owner/i)).toBeTruthy();
  });

  it("an owner makes the rule weaker after a step-up", async () => {
    api.fetchTenantMfaPolicy.mockResolvedValue("required_for_all");
    api.fetchMySecurity.mockResolvedValue({ loginType: "local", passwordChangedAt: null, totpEnabled: true, recoveryCodesRemaining: 10, mfaRequired: true });
    api.stepUp.mockResolvedValue("step-up-token");
    api.saveTenantMfaPolicy.mockResolvedValue("optional");
    renderPolicy("owner");

    fireEvent.click(await screen.findByRole("radio", { name: /optional/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Code from your authenticator app"), { target: { value: "123456" } });
    const confirm = within(dialog).getByRole("button", { name: "Save rule" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() => expect(api.saveTenantMfaPolicy).toHaveBeenCalledWith("optional", "step-up-token"));
    expect(api.stepUp).toHaveBeenCalledWith("tenant.mfa_policy", { totpCode: "123456" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("shows initial loading, a failed read and a guarded local retry without a default choice", async () => {
  const initial = deferred<string>();
  const retry = deferred<string>();
  api.fetchTenantMfaPolicy.mockReturnValueOnce(initial.promise).mockReturnValueOnce(retry.promise);
  renderPolicy("owner");
  expect(screen.getByRole("status").textContent).toMatch(/loading the saved rule/i);
  expect(screen.queryByRole("radio")).toBeNull();
  await act(async () => initial.reject(new Error("offline")));
  const button = await screen.findByRole("button", { name: "Retry rule" });
  expect(screen.getByRole("alert").textContent).toMatch(/could not load/i);
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.fetchTenantMfaPolicy).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry rule" }).getAttribute("aria-busy")).toBe("true"));
  expect(document.activeElement).toBe(button);
  await act(async () => retry.resolve("required_for_admins"));
  expect((await screen.findByRole("radio", { name: /required for owners/i }) as HTMLInputElement).checked).toBe(true);
});

it("keeps the last saved rule and draft separate after a failed refresh", async () => {
  api.fetchTenantMfaPolicy.mockResolvedValueOnce("optional").mockRejectedValueOnce(new Error("offline"));
  const client = renderPolicy("owner");
  fireEvent.click(await screen.findByRole("radio", { name: /required for everyone/i }));
  await act(async () => { await client.refetchQueries(); });
  expect((await screen.findByRole("alert")).textContent).toMatch(/last known saved rule/i);
  expect(screen.getByText("Last known saved rule: Optional.")).toBeTruthy();
  expect((screen.getByRole("radio", { name: /required for everyone/i }) as HTMLInputElement).checked).toBe(true);
});

it("retains a failed save choice and refetches the saved rule", async () => {
  api.fetchTenantMfaPolicy.mockResolvedValue("optional");
  api.saveTenantMfaPolicy.mockRejectedValue(new Error("offline"));
  renderPolicy("admin");
  fireEvent.click(await screen.findByRole("radio", { name: /required for everyone/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  await screen.findByRole("alert");
  expect(api.fetchTenantMfaPolicy).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("radio", { name: /required for everyone/i }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("Saved rule: Optional.")).toBeTruthy();
});

it("guards repeated saves synchronously and preserves a choice made during the request", async () => {
  const saved = deferred<string>();
  api.fetchTenantMfaPolicy.mockResolvedValue("optional");
  api.saveTenantMfaPolicy.mockReturnValue(saved.promise);
  renderPolicy("owner");
  fireEvent.click(await screen.findByRole("radio", { name: /required for everyone/i }));
  const button = screen.getByRole("button", { name: "Save rule" });
  button.focus();
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(api.saveTenantMfaPolicy).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: /required for owners/i }));
  await act(async () => saved.resolve("required_for_all"));
  expect((screen.getByRole("radio", { name: /required for owners/i }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("Saved rule: Required for everyone.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/newer choice has not been saved/i);
});
