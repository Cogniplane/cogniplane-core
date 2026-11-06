// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const login = vi.hoisted(() => vi.fn());
const completeLogin = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ fetchAuthConfig: vi.fn(), signInWithPassword: vi.fn(), submitTotpCode: vi.fn(), signInWithPasskey: vi.fn() }));
const browser = vi.hoisted(() => ({ passkeysSupported: vi.fn(() => true) }));
vi.mock("../../lib/passkey-browser", async (importOriginal) => ({ ...(await importOriginal<object>()), ...browser }));

vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ login, completeLogin }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("../../lib/local-auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/local-auth-api")>();
  return { ...actual, ...api };
});

import LoginPage from "./page";

function config(loginTypes: Array<"workos" | "local">) {
  return { mode: "jwt", loginTypes, passwordRecovery: false, passkeys: false };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><LoginPage /></QueryClientProvider>);
}

beforeEach(() => {
  api.fetchAuthConfig.mockResolvedValue(config(["workos"]));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("login page, WorkOS only", () => {
  it("shows no password form", async () => {
    renderPage();
    await screen.findByRole("button", { name: /continue with your company account/i });
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});

describe("login page, local login", () => {
  async function fillAndSubmit() {
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a long passphrase here" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("signs in, starts the session, and opens the workspace", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(["local"]));
    api.signInWithPassword.mockResolvedValue({ accessToken: "tok-1", user: {} });
    completeLogin.mockResolvedValue(true);

    renderPage();
    await fillAndSubmit();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(api.signInWithPassword).toHaveBeenCalledWith("alice@example.com", "a long passphrase here");
    expect(completeLogin).toHaveBeenCalledWith("tok-1");
    // A local-only installation shows no WorkOS button.
    expect(screen.queryByRole("button", { name: /company account|sign in with email/i })).toBeNull();
  });

  it("asks for the authenticator code after the password, then opens the workspace", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(["local"]));
    api.signInWithPassword.mockResolvedValue({ next: "mfa", methods: ["totp", "recovery_code"] });
    api.submitTotpCode.mockResolvedValue({ accessToken: "tok-2", user: {} });
    completeLogin.mockResolvedValue(true);

    renderPage();
    await fillAndSubmit();
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    expect(completeLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(completeLogin).toHaveBeenCalledWith("tok-2");
  });

  it("signs in with a passkey when the installation offers passkeys", async () => {
    api.fetchAuthConfig.mockResolvedValue({ ...config(["local"]), passkeys: true });
    browser.passkeysSupported.mockReturnValue(true);
    api.signInWithPasskey.mockResolvedValue({ accessToken: "tok-pk", user: {} });
    completeLogin.mockResolvedValue(true);

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(completeLogin).toHaveBeenCalledWith("tok-pk");
    expect(api.signInWithPassword).not.toHaveBeenCalled();
  });

  it("shows no passkey button without passkeys or without browser support", async () => {
    api.fetchAuthConfig.mockResolvedValue({ ...config(["local"]), passkeys: false });
    renderPage();
    await screen.findByLabelText("Email");
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
    cleanup();

    api.fetchAuthConfig.mockResolvedValue({ ...config(["local"]), passkeys: true });
    browser.passkeysSupported.mockReturnValue(false);
    renderPage();
    await screen.findByLabelText("Email");
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });

  it("goes back to an empty password form from the code step", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(["local"]));
    api.signInWithPassword.mockResolvedValue({ next: "mfa" });

    renderPage();
    await fillAndSubmit();
    fireEvent.click(await screen.findByRole("button", { name: "Start again" }));

    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect(screen.queryByLabelText("Code")).toBeNull();
  });

  it("shows both forms when the installation offers both", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(["workos", "local"]));
    renderPage();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue with your company account/i })).toBeTruthy();
  });

  it("offers a retry when the sign-in options do not load", async () => {
    // The page retries once by itself, so two failures reach the screen.
    api.fetchAuthConfig
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(config(["local"]));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }, { timeout: 4000 }));
    expect(await screen.findByLabelText("Password")).toBeTruthy();
  });
});

describe("login page, forgot password", () => {
  it("links to the reset page when the installation sends reset links", async () => {
    api.fetchAuthConfig.mockResolvedValue({ ...config(["local"]), passwordRecovery: true });
    renderPage();
    const link = await screen.findByRole("link", { name: "Forgot your password?" });
    expect(link.getAttribute("href")).toBe("/auth/forgot-password");
    expect(screen.queryByText(/ask your administrator/i)).toBeNull();
  });

  it("sends people to their administrator otherwise", async () => {
    api.fetchAuthConfig.mockResolvedValue(config(["local"]));
    renderPage();
    expect(await screen.findByText(/ask your administrator for a reset link/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Forgot your password?" })).toBeNull();
  });
});

it("holds hosted actions during local submission and hides alternatives after the MFA step starts", async () => {
  api.fetchAuthConfig.mockResolvedValue(config(["local", "workos"]));
  let resolve!: (value: unknown) => void;
  api.signInWithPassword.mockReturnValue(new Promise(done => { resolve = done; }));
  renderPage();
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "synthetic@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  const hosted = screen.getByRole("button", { name: "Continue with your company account" });
  fireEvent.click(hosted);
  expect(hosted.hasAttribute("disabled")).toBe(true);
  expect(login).not.toHaveBeenCalled();
  resolve({ next: "mfa", methods: ["totp", "recovery_code"] });
  await screen.findByLabelText("Code");
  expect(screen.queryByRole("button", { name: "Continue with your company account" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start again" }));
  expect(screen.getByRole("button", { name: "Continue with your company account" })).toBeTruthy();
  expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  // Start again unmounts itself; focus returns to the kept email.
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("synthetic@example.test");
  expect(document.activeElement).toBe(screen.getByLabelText("Email"));
});

it("uses an explicitly labelled organization input and the same hosted login contract", async () => {
  renderPage();
  await screen.findByRole("button", { name: "Continue with your company account" });
  const details = screen.getByText("Have an organization identifier?").closest("details");
  details?.setAttribute("open", "");
  const input = screen.getByLabelText("Organization identifier");
  expect(input.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.change(input, { target: { value: "  synthetic-org  " } });
  login.mockImplementation(() => new Promise(() => {}));
  const organization = screen.getByRole("button", { name: "Continue with organization" });
  fireEvent.click(organization);
  expect(login).toHaveBeenCalledExactlyOnceWith({ organization: "synthetic-org" });
  // The field stays focusable and readable, but cannot change while the sign-in page opens.
  expect((input as HTMLInputElement).disabled).toBe(false);
  expect((input as HTMLInputElement).readOnly).toBe(true);
  expect(input.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("status").textContent).toMatch(/opening your organization/i);
  fireEvent.submit(input.closest("form")!);
  fireEvent.click(screen.getByRole("button", { name: /redirecting/i }));
  fireEvent.click(screen.getByRole("button", { name: /continue with your company account/i }));
  expect(login).toHaveBeenCalledTimes(1);
});

it("holds local sign-in fields read-only and starts one request for repeated submits", async () => {
  api.fetchAuthConfig.mockResolvedValue({ ...config(["local"]), passkeys: true });
  browser.passkeysSupported.mockReturnValue(true);
  api.signInWithPassword.mockReturnValue(new Promise(() => {}));
  renderPage();
  const email = await screen.findByLabelText("Email") as HTMLInputElement;
  fireEvent.change(email, { target: { value: "synthetic@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic password" } });
  email.focus();
  fireEvent.submit(email.closest("form")!);
  fireEvent.submit(email.closest("form")!);
  const submit = screen.getByRole("button", { name: /signing in/i });
  fireEvent.click(submit);
  expect(api.signInWithPassword).toHaveBeenCalledTimes(1);
  expect(email.readOnly).toBe(true);
  expect(email.disabled).toBe(false);
  expect(document.activeElement).toBe(email);
  expect(submit.getAttribute("aria-busy")).toBe("true");
  // The other method waits: it cannot start a parallel sign-in.
  const passkey = screen.getByRole("button", { name: "Sign in with a passkey" }) as HTMLButtonElement;
  expect(passkey.disabled).toBe(true);
  fireEvent.click(passkey);
  expect(api.signInWithPasskey).not.toHaveBeenCalled();
});
