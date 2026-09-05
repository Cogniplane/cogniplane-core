// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const login = vi.hoisted(() => vi.fn());
vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ login })
}));

import LoginPage from "./page";

afterEach(() => {
  cleanup();
  login.mockReset();
});

describe("login page", () => {
  it("shows the failure and re-enables the button when sign-in is unavailable", async () => {
    // login() only ever returns on failure — on success it navigates away. So
    // a page that leaves the button on "Redirecting…" is a dead end.
    login.mockRejectedValue(new Error("Sign-in is unavailable right now (502)."));

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with email/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/unavailable/i)
    );
    const button = screen.getByRole("button", { name: /sign in with email/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears a previous failure when the user retries", async () => {
    login.mockRejectedValueOnce(new Error("Sign-in is unavailable right now (502)."));
    login.mockImplementation(() => new Promise(() => {}));

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with email/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /sign in with email/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    const button = screen.getByRole("button", { name: /redirecting/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
