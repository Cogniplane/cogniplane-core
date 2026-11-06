// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { LoginView } from "./login-view";
import { LocalAuthError } from "../../lib/local-auth-api";
import { authFlowActions } from "./auth-flow-actions";

vi.mock("../../lib/passkey-browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/passkey-browser")>(),
  passkeysSupported: () => true
}));

afterEach(() => cleanup());

const CONFIG = { mode: "jwt" as const, loginTypes: ["workos" as const], passwordRecovery: false, passkeys: false };

it.each([
  { method: "company", error: new Error("Sign-in is unavailable right now (502)."), message: /company sign-in is unavailable/i },
  { method: "organization", error: new Error("Synthetic unavailable"), message: /organization identifier/i },
  { method: "password", error: new Error("Sample failure"), message: /sign-in is unavailable/i },
  { method: "password", error: new LocalAuthError("invalid_credentials", 401), message: /email or password is not correct/i },
  { method: "password", error: new LocalAuthError("too_many_attempts", 401), message: /too many attempts/i },
  { method: "passkey", error: new LocalAuthError("passkey_cancelled", 0), message: /passkey/i }
])("keeps $method failure beside its owner, preserves input and permits retry: $error", async ({ method, error, message }) => {
  const login = vi.fn().mockRejectedValueOnce(error).mockImplementation(() => new Promise<void>(() => {}));
  const signInWithPassword = vi.fn().mockRejectedValueOnce(error).mockImplementation(() => new Promise<never>(() => {}));
  const signInWithPasskey = vi.fn().mockRejectedValueOnce(error).mockImplementation(() => new Promise<never>(() => {}));
  const onSignedIn = vi.fn();
  render(<LoginView config={{ ...CONFIG, loginTypes: ["local", "workos"], passkeys: true }} configError={false}
    onConfigRetry={vi.fn()} onSignedIn={onSignedIn} login={login}
    actions={{ ...authFlowActions, signInWithPassword, signInWithPasskey }} />);
  screen.getByText("Have an organization identifier?").closest("details")?.setAttribute("open", "");
  const input = screen.getByLabelText("Organization identifier") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic-org" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sample@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "sample-password" } });
  const names = {
    company: "Continue with your company account", organization: "Continue with organization",
    password: "Sign in", passkey: "Sign in with a passkey"
  };
  const button = screen.getByRole("button", { name: names[method as keyof typeof names] }) as HTMLButtonElement;
  button.focus(); fireEvent.click(button);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(message);
  expect(button.getAttribute("aria-describedby")).toBe(alert.id);
  expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const name of Object.values(names).filter(name => name !== button.textContent)) {
    expect(screen.getByRole("button", { name }).getAttribute("aria-describedby")).toBeNull();
  }
  expect(document.activeElement).toBe(button);
  expect(button.disabled).toBe(false);
  expect(input.value).toBe("synthetic-org");
  expect(onSignedIn).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  const request = method === "password" ? signInWithPassword : method === "passkey" ? signInWithPasskey : login;
  expect(request).toHaveBeenCalledTimes(2);
  expect(onSignedIn).not.toHaveBeenCalled();
});

it("keeps Try again focused while the sign-in options load again, then focuses the title", async () => {
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>(done => { finish = done; }));
  const props = { onConfigRetry: retry, onSignedIn: vi.fn(), login: vi.fn(), actions: authFlowActions };
  const { rerender } = render(<LoginView config={null} configError {...props} />);
  const button = screen.getByRole("button", { name: "Try again" });
  button.focus();
  fireEvent.click(button);
  // Production refetch resets the query to loading; the button stays to own focus.
  rerender(<LoginView config={null} configError={false} {...props} />);
  fireEvent.click(button);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
  expect(screen.queryByText("Loading sign-in…")).toBeNull();
  rerender(<LoginView config={CONFIG} configError={false} {...props} />);
  finish();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
});

it("keeps focus on Try again after another failure", async () => {
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>(done => { finish = done; }));
  const props = { onConfigRetry: retry, onSignedIn: vi.fn(), login: vi.fn(), actions: authFlowActions };
  const { rerender } = render(<LoginView config={null} configError {...props} />);
  const button = screen.getByRole("button", { name: "Try again" });
  button.focus();
  fireEvent.click(button);
  rerender(<LoginView config={null} configError {...props} />);
  finish();
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  expect(document.activeElement).toBe(button);
  expect(screen.getByRole("alert").textContent).toMatch(/could not load/i);
});

it("does not take focus back from a control outside the sign-in card", async () => {
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>(done => { finish = done; }));
  const props = { onConfigRetry: retry, onSignedIn: vi.fn(), login: vi.fn(), actions: authFlowActions };
  const view = (config: typeof CONFIG | null, configError: boolean) => <><LoginView config={config} configError={configError} {...props} /><button type="button">Outside sample</button></>;
  const { rerender } = render(view(null, true));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const outside = screen.getByRole("button", { name: "Outside sample" });
  outside.focus();
  rerender(view(CONFIG, false));
  finish();
  await waitFor(() => expect(retry).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.activeElement).toBe(outside);
});

it("keeps a rejected retry inside the view, with focus on Try again", async () => {
  const retry = vi.fn().mockRejectedValue(new Error("Synthetic retry failure"));
  render(<LoginView config={null} configError onConfigRetry={retry} onSignedIn={vi.fn()} login={vi.fn()} actions={authFlowActions} />);
  const button = screen.getByRole("button", { name: "Try again" });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
  expect(retry).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
});

it.each([
  ["password", false], ["password", true], ["passkey", false], ["passkey", true]
] as const)("keeps the workspace failure reachable after %s sign-in, outside focus %s", async (method, movedOutside) => {
  let finish!: (loaded: boolean) => void;
  const onSignedIn = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const session = { accessToken: "sample-token", user: { userId: "sample-user", email: "sample@example.test", displayName: "Sample", tenantId: "sample-tenant", role: "member" as const } };
  const signInWithPassword = vi.fn().mockResolvedValue(session);
  const signInWithPasskey = vi.fn().mockResolvedValue(session);
  const reload = vi.fn();
  render(<>
    <LoginView
      config={{ ...CONFIG, loginTypes: ["local"], passkeys: true }} configError={false}
      onConfigRetry={vi.fn()} onSignedIn={onSignedIn} login={vi.fn()} onReload={reload}
      actions={{ ...authFlowActions, signInWithPassword, signInWithPasskey }}
    />
    <button type="button">Outside sample</button>
  </>);
  if (method === "password") {
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "sample@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "sample-password" } });
  }
  const trigger = screen.getByRole("button", { name: method === "password" ? "Sign in" : "Sign in with a passkey" });
  trigger.focus();
  fireEvent.click(trigger);
  await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith("sample-token"));
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  const outside = screen.getByRole("button", { name: "Outside sample" });
  if (movedOutside) outside.focus();
  finish(false);
  const heading = await screen.findByRole("heading", { name: "Workspace did not load" });
  await waitFor(() => expect(document.activeElement).toBe(movedOutside ? outside : heading));
  expect(screen.getByRole("heading", { level: 1 })).toBe(heading);
  expect(screen.queryByRole("heading", { name: "Sign in to your workspace" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Sign-in completed, but your workspace details could not load.");
  expect(signInWithPassword).toHaveBeenCalledTimes(method === "password" ? 1 : 0);
  expect(signInWithPasskey).toHaveBeenCalledTimes(method === "passkey" ? 1 : 0);
  fireEvent.click(screen.getByRole("button", { name: "Reload the page" }));
  expect(reload).toHaveBeenCalledTimes(1);
});
