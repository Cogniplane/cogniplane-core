// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetchAuthConfig: vi.fn(), requestPasswordReset: vi.fn() }));
vi.mock("../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import { LocalAuthError } from "../../lib/local-auth-api";
import { ForgotPasswordForm } from "./forgot-password-form";

function renderForm(passwordRecovery: boolean) {
  api.fetchAuthConfig.mockResolvedValue({ mode: "jwt", loginTypes: ["local"], passwordRecovery, passkeys: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><ForgotPasswordForm /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("forgot password page", () => {
  it("sends the address and shows the same answer for every address", async () => {
    api.requestPasswordReset.mockResolvedValue(undefined);
    renderForm(true);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: " max@example.test " } });
    const submit = screen.getByRole("button", { name: "Send the link" });
    submit.focus();
    fireEvent.click(submit);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("If an account uses max@example.test, we sent it a link");
    expect(status.textContent).toContain("30 minutes");
    expect(status.querySelector("button, a")).toBeNull();
    expect(api.requestPasswordReset).toHaveBeenCalledWith("max@example.test");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));

    fireEvent.click(screen.getByRole("button", { name: "Use another address" }));
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(screen.getByLabelText("Email"));
  });

  it("shows a rate limit and keeps the form", async () => {
    api.requestPasswordReset.mockRejectedValue(new LocalAuthError("limit_exceeded", 429));
    renderForm(true);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "max@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too many requests/i));
    const button = screen.getByRole("button", { name: "Send the link" });
    const error = screen.getByRole("alert");
    expect(button.getAttribute("aria-describedby")).toBe(error.id);
    expect(button.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("without email, sends people to their administrator", async () => {
    renderForm(false);
    expect(await screen.findByText(/ask your administrator for a reset link/i)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to sign-in" }).getAttribute("href")).toBe("/login");
  });
});

it("keeps Try again focused while password recovery options load again, then focuses the title", async () => {
  const { ForgotPasswordContent } = await import("./forgot-password-form");
  let finish!: () => void;
  const refetch = vi.fn(() => new Promise<void>(done => { finish = done; }));
  const failed = { data: undefined, isPending: false, isError: true, refetch };
  const { rerender } = render(<ForgotPasswordContent configQuery={failed} />);
  expect(screen.getByRole("alert").textContent).toMatch(/password recovery options could not load/i);
  const retry = screen.getByRole("button", { name: "Try again" });
  retry.focus();
  fireEvent.click(retry);
  // Production refetch resets the query to pending; the button stays to own focus.
  rerender(<ForgotPasswordContent configQuery={{ data: undefined, isPending: true, isError: false, refetch }} />);
  fireEvent.click(retry);
  expect(refetch).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(retry);
  expect(retry.getAttribute("aria-busy")).toBe("true");
  rerender(<ForgotPasswordContent configQuery={{ data: { passwordRecovery: true }, isPending: false, isError: false, refetch }} />);
  finish();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
});

it("starts one reset request for repeated submits and keeps the email readable", async () => {
  api.requestPasswordReset.mockReturnValue(new Promise(() => {}));
  renderForm(true);
  const email = await screen.findByLabelText("Email") as HTMLInputElement;
  fireEvent.change(email, { target: { value: "max@example.test" } });
  fireEvent.submit(email.closest("form")!);
  fireEvent.submit(email.closest("form")!);
  fireEvent.click(screen.getByRole("button", { name: /sending/i }));
  expect(api.requestPasswordReset).toHaveBeenCalledTimes(1);
  expect(email.readOnly).toBe(true);
  expect(email.value).toBe("max@example.test");
});
