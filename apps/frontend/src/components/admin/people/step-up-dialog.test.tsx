// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySecurityResponse } from "@cogniplane/shared-types";
import { ApiError } from "../../../lib/api-client";
import { queryKeys } from "../../../lib/query-keys";
import { StepUpDialog } from "./step-up-dialog";

const api = vi.hoisted(() => ({ fetchMySecurity: vi.fn(), stepUp: vi.fn() }));
const supported = vi.hoisted(() => vi.fn(() => true));
vi.mock("../../../lib/local-auth-api", async original => ({ ...await original<typeof import("../../../lib/local-auth-api")>(), ...api }));
vi.mock("../../../lib/passkey-browser", async original => ({ ...await original<typeof import("../../../lib/passkey-browser")>(), passkeysSupported: supported }));
const passwordSecurity: MySecurityResponse = { loginType: "local", passwordChangedAt: null, totpEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0, mfaRequired: false };
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function mount(initial?: MySecurityResponse, initiallyOpen = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  if (initial) client.setQueryData(queryKeys.settings.security(), initial);
  const run = vi.fn(async (_token: string) => {});
  function Harness() {
    const [open, setOpen] = useState(initiallyOpen);
    return <><button onClick={() => setOpen(true)}>Open confirmation</button><StepUpDialog open={open} onOpenChange={setOpen} action="tenant.settings" title="Confirm changes" description="Review organization changes." confirmLabel="Apply changes" run={run} /></>;
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  const submit = () => fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  const confirm = () => screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement;
  return { client, run, submit, confirm };
}
beforeEach(() => { vi.resetAllMocks(); supported.mockReturnValue(true); api.fetchMySecurity.mockResolvedValue(passwordSecurity); api.stepUp.mockResolvedValue("action-bound-token"); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });

describe("security method reads", () => {
  it("shows no guessed method and sends no proof while the initial read waits or fails", async () => {
    const read = deferred<MySecurityResponse>(); api.fetchMySecurity.mockReturnValue(read.promise);
    const view = mount();
    expect(screen.getByText("Checking how to confirm your identity...")).toBeTruthy();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    expect(view.confirm().disabled).toBe(true);
    view.submit(); expect(api.stepUp).not.toHaveBeenCalled();
    await act(async () => read.reject(new Error("offline")));
    await screen.findByRole("button", { name: "Retry security check" });
    expect(screen.queryByLabelText("Your password")).toBeNull();
    expect(view.confirm().disabled).toBe(true);
    view.submit(); expect(api.stepUp).not.toHaveBeenCalled(); expect(view.run).not.toHaveBeenCalled();
  });

  it("retries once under repeated activation, selects the returned method and keeps a moved focus", async () => {
    api.fetchMySecurity.mockRejectedValueOnce(new Error("offline"));
    const view = mount();
    const retry = await screen.findByRole("button", { name: "Retry security check" });
    const dialog = screen.getByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ bottom: 600 } as DOMRect);
    const read = deferred<MySecurityResponse>(); api.fetchMySecurity.mockReturnValue(read.promise);
    retry.focus(); fireEvent.click(retry); fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(api.fetchMySecurity).toHaveBeenCalledTimes(2));
    expect(retry.getAttribute("aria-busy")).toBe("true");
    const anchor = dialog.style.bottom; expect(anchor).not.toBe("");
    expect(view.confirm().disabled).toBe(true); view.submit();
    const cancel = screen.getByRole("button", { name: "Cancel" }); cancel.focus();
    await act(async () => read.resolve({ ...passwordSecurity, totpEnabled: true }));
    await screen.findByLabelText("Code from your authenticator app");
    expect(document.activeElement).toBe(cancel);
    expect(dialog.style.bottom).toBe(anchor);
    expect(screen.queryByRole("button", { name: "Retry security check" })).toBeNull();
    expect(api.stepUp).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Code from your authenticator app"), { target: { value: " 123456 " } });
    view.submit();
    await waitFor(() => expect(api.stepUp).toHaveBeenCalledWith("tenant.settings", { totpCode: "123456" }));
    expect(view.run).toHaveBeenCalledWith("action-bound-token");
  });

  it("keeps failed retries recoverable and can cancel a read without late proof or action", async () => {
    api.fetchMySecurity.mockRejectedValue(new Error("offline"));
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry security check" }));
    await waitFor(() => expect(api.fetchMySecurity).toHaveBeenCalledTimes(2));
    await screen.findByText("Could not load your security methods. Retry to confirm this action.");
    const read = deferred<MySecurityResponse>(); api.fetchMySecurity.mockReturnValue(read.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry security check" }));
    await waitFor(() => expect(api.fetchMySecurity).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => read.resolve(passwordSecurity));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(api.stepUp).not.toHaveBeenCalled(); expect(view.run).not.toHaveBeenCalled();
  });

  it("does not use cached methods during a failed refresh", async () => {
    api.fetchMySecurity.mockRejectedValue(new Error("offline"));
    const view = mount({ ...passwordSecurity, totpEnabled: true });
    await screen.findByRole("button", { name: "Retry security check" });
    expect(screen.queryByLabelText("Code from your authenticator app")).toBeNull();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    expect(view.confirm().disabled).toBe(true); view.submit(); expect(api.stepUp).not.toHaveBeenCalled();
  });
});

describe("known methods and action ownership", () => {
  it.each([
    { data: passwordSecurity, label: "Your password", proof: { password: "my-password" } },
    { data: { ...passwordSecurity, totpEnabled: true, passkeyCount: 1 }, label: "Code from your authenticator app", proof: { totpCode: "my-password" } }
  ])("keeps $label proof bound to the requested action and serializes submissions", async ({ data, label, proof }) => {
    api.fetchMySecurity.mockResolvedValue(data);
    const pending = deferred<string>(); api.stepUp.mockReturnValue(pending.promise);
    const view = mount();
    fireEvent.change(await screen.findByLabelText(label), { target: { value: "my-password" } });
    view.submit(); view.submit(); view.submit();
    expect(api.stepUp).toHaveBeenCalledTimes(1); expect(api.stepUp).toHaveBeenCalledWith("tenant.settings", proof);
    expect(view.confirm().getAttribute("aria-busy")).toBe("true");
    expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
    await act(async () => pending.resolve("action-bound-token"));
    expect(view.run).toHaveBeenCalledTimes(1); expect(view.run).toHaveBeenCalledWith("action-bound-token");
  });

  it("uses passkey-only proof after a known read without requesting a password", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...passwordSecurity, passkeyCount: 1 });
    const view = mount(); await screen.findByText(/confirm this action with one of your passkeys/);
    expect(screen.queryByLabelText("Your password")).toBeNull();
    view.submit(); await waitFor(() => expect(api.stepUp).toHaveBeenCalledWith("tenant.settings", { passkey: true }));
  });

  it("does not fall back to password when the known account requires an unsupported passkey", async () => {
    supported.mockReturnValue(false); api.fetchMySecurity.mockResolvedValue({ ...passwordSecurity, passkeyCount: 1 });
    const view = mount(); await screen.findByText(/browser that supports passkeys/);
    expect(view.confirm().disabled).toBe(true); expect(screen.queryByLabelText("Your password")).toBeNull();
    view.submit(); expect(api.stepUp).not.toHaveBeenCalled();
  });

  it("describes only the method whose proof failed with the error", async () => {
    api.fetchMySecurity.mockResolvedValue({ ...passwordSecurity, totpEnabled: true, passkeyCount: 1 });
    const view = mount();
    fireEvent.change(await screen.findByLabelText("Code from your authenticator app"), { target: { value: "000000" } });
    const passkey = screen.getByRole("button", { name: "Use a passkey instead" });
    api.stepUp.mockRejectedValueOnce(new Error("Wrong code"));
    view.submit();
    await screen.findByText("The action failed. Try again.");
    expect(view.confirm().getAttribute("aria-describedby")).toBeTruthy();
    expect(passkey.getAttribute("aria-describedby")).toBeNull();
    api.stepUp.mockRejectedValueOnce(new Error("Passkey cancelled"));
    fireEvent.click(passkey);
    await waitFor(() => expect(passkey.getAttribute("aria-describedby")).toBeTruthy());
    expect(view.confirm().getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps decision anchoring, input and user focus through a general proof failure and retry", async () => {
    const view = mount(); const field = await screen.findByLabelText("Your password");
    const dialog = screen.getByRole("dialog");
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ bottom: 600 } as DOMRect);
    fireEvent.change(field, { target: { value: "keep-this-password" } });
    const pending = deferred<string>(); api.stepUp.mockReturnValue(pending.promise);
    view.confirm().focus(); view.submit();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    // The pending proof owns the action. Simulate focus moved to another enabled control.
    screen.getByRole("button", { name: "Close" }).focus(); const moved = document.activeElement;
    await act(async () => pending.reject(new Error("Proof failed")));
    await screen.findByText("The action failed. Try again.");
    expect(document.activeElement).toBe(moved);
    expect((field as HTMLInputElement).value).toBe("keep-this-password");
    const anchor = dialog.style.bottom; expect(anchor).not.toBe("");
    const next = deferred<string>(); api.stepUp.mockReturnValue(next.promise); view.submit(); view.submit();
    expect(api.stepUp).toHaveBeenCalledTimes(2); expect(dialog.style.bottom).toBe(anchor);
    await act(async () => next.reject(new Error("Proof failed again")));
    expect(dialog.style.bottom).toBe(anchor);
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });
});


it("restores the opener after canceling a security retry and ignores its late read", async () => {
  api.fetchMySecurity.mockRejectedValueOnce(new Error("offline"));
  const view = mount(undefined, false);
  const opener = screen.getByRole("button", { name: "Open confirmation" }); opener.focus(); fireEvent.click(opener);
  const retry = await screen.findByRole("button", { name: "Retry security check" });
  const read = deferred<MySecurityResponse>(); api.fetchMySecurity.mockReturnValue(read.promise);
  retry.focus(); fireEvent.click(retry);
  await waitFor(() => expect(api.fetchMySecurity).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await act(async () => read.resolve(passwordSecurity));
  expect(document.activeElement).toBe(opener); expect(view.run).not.toHaveBeenCalled(); expect(api.stepUp).not.toHaveBeenCalled();
});

it.each(["Apply changes", "Use a passkey instead"])("keeps progress, focus and proof errors on the owning method: %s", async (ownerName) => {
  api.fetchMySecurity.mockResolvedValue({ ...passwordSecurity, totpEnabled: true, passkeyCount: 1 });
  const proof = deferred<string>(); api.stepUp.mockReturnValue(proof.promise);
  const view = mount();
  const code = await screen.findByLabelText("Code from your authenticator app");
  fireEvent.change(code, { target: { value: "123456" } });
  const owner = screen.getByRole("button", { name: ownerName }) as HTMLButtonElement;
  const other = screen.getByRole("button", { name: ownerName === "Apply changes" ? "Use a passkey instead" : "Apply changes" }) as HTMLButtonElement;
  owner.focus(); fireEvent.click(owner); fireEvent.click(owner); fireEvent.click(other);
  view.submit();
  expect(api.stepUp).toHaveBeenCalledExactlyOnceWith("tenant.settings", ownerName === "Apply changes" ? { totpCode: "123456" } : { passkey: true });
  expect(owner.disabled).toBe(false);
  expect(owner.getAttribute("aria-busy")).toBe("true");
  expect(owner.querySelector('[data-icon="pending"]')).toBeTruthy();
  expect(other.disabled).toBe(true);
  expect(other.getAttribute("aria-busy")).toBeNull();
  expect(other.querySelector('[data-icon="pending"].animate-spin')).toBeNull();
  expect(other.querySelector('[data-icon="pending"]')?.classList.contains("invisible")).toBe(true);
  expect((code as HTMLInputElement).readOnly).toBe(true);
  expect(document.activeElement).toBe(owner);
  await act(async () => {
    proof.reject(ownerName === "Apply changes"
      ? new ApiError({ code: "invalid_code", status: 400, method: "POST", path: "/auth/step-up", message: "invalid_code" })
      : new Error("Invalid proof"));
  });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).not.toContain("email");
  expect(owner.getAttribute("aria-describedby")).toBe(alert.id);
  expect(other.disabled).toBe(false);
  expect(document.activeElement).toBe(owner);
  expect(view.run).not.toHaveBeenCalled();
});
