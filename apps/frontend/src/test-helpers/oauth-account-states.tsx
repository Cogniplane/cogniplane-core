import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { OAuthConnectionReadState } from "../components/oauth-connection-presentation";

// Shared account-state checks for the OAuth connection sections. The public
// providers and the private Microsoft overlay run the same suite from their own
// test files, so the public mirror keeps its provider tests.
export const connectionDates = { connectedAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z", lastUsedAt: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, suspended: false };
export type ConnectionHandlers = { error: null; flashMessage: null; busyKey: null; onConnect: Mock; onDisconnect: Mock; onConfirm: Mock; onRetry: Mock };
export const connectionHandlers = (): ConnectionHandlers => ({ error: null, flashMessage: null, busyKey: null, onConnect: vi.fn(), onDisconnect: vi.fn(), onConfirm: vi.fn(), onRetry: vi.fn() });
export type ConnectionStateChanges = OAuthConnectionReadState & { unknown?: boolean; disabled?: boolean; suspended?: boolean };
export type ConnectionStateCase = { provider: string; identity: string; mount: (props: ConnectionHandlers, changes: ConnectionStateChanges) => ReactNode };

export function describeConnectionAccountStates(cases: ConnectionStateCase[]) {
  describe.each(cases)("$provider account state", ({ provider, identity, mount }) => {
    it("does not claim a negative state before the first status read", () => {
      const props = connectionHandlers();
      render(mount(props, { unknown: true, isLoading: true }));
      expect(screen.getByRole("heading", { level: 1, name: provider })).toBeTruthy();
      expect(screen.getByRole("status").textContent).toContain("Checking your connection");
      expect(screen.queryByText(/not configured|not connected|not set up/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /Connect|Disconnect/ })).toBeNull();
    });

    it("retries only the status read after an initial failure", () => {
      const props = connectionHandlers();
      render(mount(props, { unknown: true, statusError: "Status read failed" }));
      expect(screen.getByRole("alert").textContent).toContain("Status read failed");
      fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
      expect(props.onRetry).toHaveBeenCalledOnce();
      expect(props.onConnect).not.toHaveBeenCalled();
      expect(props.onConfirm).not.toHaveBeenCalled();
      expect(screen.queryByText(/not configured|not connected|not set up/i)).toBeNull();
    });

    it("keeps the known account during refresh and marks stale reads after failure", () => {
      const props = connectionHandlers();
      const { rerender } = render(mount(props, { isLoading: true }));
      expect(screen.getByRole("heading", { name: identity })).toBeTruthy();
      expect(screen.getByText("Refreshing connection status. Showing the last known account.").getAttribute("role")).toBe("status");
      rerender(mount(props, { statusError: "Status read failed" }));
      expect(screen.getByRole("heading", { name: identity })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain("last successful check");
      expect((screen.getByRole("button", { name: /Reconnect|Connect another/ }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
      expect(props.onRetry).toHaveBeenCalledOnce();
    });

    it("keeps removal available when the organization disables new use", () => {
      const props = connectionHandlers();
      render(mount(props, { disabled: true, suspended: true }));
      expect(screen.getByText(`${provider} is disabled by your organization`)).toBeTruthy();
      expect(screen.getByText(/Admin > Connections/)).toBeTruthy();
      expect((screen.getByRole("button", { name: /Reconnect|Connect another/ }) as HTMLButtonElement).disabled).toBe(true);
      const confirm = screen.queryByRole("button", { name: "Confirm connection" }) as HTMLButtonElement | null;
      if (confirm) { expect(confirm.disabled).toBe(true); fireEvent.click(confirm); }
      expect(props.onConfirm).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      expect(props.onDisconnect).toHaveBeenCalledOnce();
      expect(screen.queryByRole("heading", { name: "Repositories the agent can use" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Jira accounts" })).toBeNull();
    });
  });
}
