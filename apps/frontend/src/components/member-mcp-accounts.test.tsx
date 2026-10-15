// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { getMemberMcpConnections, removeMemberMcpCredentials, saveMemberMcpCredentials } from "@/lib/member-mcp-api";
import { MemberMcpAccounts } from "./member-mcp-accounts";

vi.mock("@/lib/member-mcp-api", () => ({ getMemberMcpConnections: vi.fn(), saveMemberMcpCredentials: vi.fn(), removeMemberMcpCredentials: vi.fn() }));
const scope = { tenantId: "tenant-a", userId: "user-a" };
const connection = {
  serverId: "research", serverName: "Research", description: "Search research",
  upstreamUrl: "https://example.com/mcp", authType: "bearer" as const, authName: null,
  credentialScope: "personal" as const, serverVersion: 4, canConnect: true,
  status: "not_connected" as const, credentialVersion: 0, hasCredential: false, accountLabel: null, updatedAt: null
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getMemberMcpConnections).mockResolvedValue({ scope, connections: [connection] });
  vi.mocked(saveMemberMcpCredentials).mockResolvedValue({ scope, connection: { ...connection, status: "connected", credentialVersion: 1, hasCredential: true, accountLabel: "Work" } });
  vi.mocked(removeMemberMcpCredentials).mockResolvedValue({ scope, removed: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("requires endpoint review, saves a write-only secret, and never prefills it", async () => {
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  expect(screen.getByText(/https:\/\/example.com\/mcp/)).toBeTruthy();
  expect(screen.getByText(/Bearer token/)).toBeTruthy();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this endpoint and authentication method." }));
  expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "private-token" } });
  fireEvent.change(screen.getByLabelText("Account label (optional)"), { target: { value: "Work" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  await waitFor(() => expect(saveMemberMcpCredentials).toHaveBeenCalledWith("research", {
    scope, version: 0, serverVersion: 4, secret: "private-token", accountLabel: "Work"
  }));
  expect(await screen.findByText("Credentials saved")).toBeTruthy();
  expect(screen.queryByDisplayValue("private-token")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace secret" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace secret" }));
  expect(screen.queryByLabelText("Secret")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this endpoint and authentication method." }));
  expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Account label (optional)") as HTMLInputElement).value).toBe("Work");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Replace secret" }));
});

it("requires at least eight secret characters before Save is available", async () => {
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  const secret = screen.getByLabelText("Secret") as HTMLInputElement;
  const save = screen.getByRole("button", { name: "Save credentials" }) as HTMLButtonElement;
  expect(secret.minLength).toBe(8);
  expect(screen.getByText("Use at least 8 characters.")).toBeTruthy();
  fireEvent.change(secret, { target: { value: "short" } });
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(saveMemberMcpCredentials).not.toHaveBeenCalled();
  fireEvent.change(secret, { target: { value: "long-enough" } });
  expect(save.disabled).toBe(false);
});

it("clears the secret and review after a version conflict, then shows the new endpoint", async () => {
  vi.mocked(saveMemberMcpCredentials).mockRejectedValueOnce(new ApiError({ status: 409, code: "member_mcp_conflict", method: "PUT", path: "/me/mcp-connections/research/credentials", message: "Connection changed" }));
  vi.mocked(getMemberMcpConnections).mockResolvedValueOnce({ scope, connections: [connection] })
    .mockResolvedValueOnce({ scope, connections: [{ ...connection, upstreamUrl: "https://new.example.com/mcp", serverVersion: 5 }] });
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "old-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Review the current endpoint"));
  expect(screen.getByText(/https:\/\/new.example.com\/mcp/)).toBeTruthy();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
  expect(saveMemberMcpCredentials).toHaveBeenCalledTimes(1);
});

it("locks and clears the form if the account changes", async () => {
  vi.mocked(saveMemberMcpCredentials).mockRejectedValueOnce(new ApiError({ status: 409, code: "member_mcp_scope_changed", method: "PUT", path: "/me/mcp-connections/research/credentials", message: "Account changed" }));
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "private-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  expect(await screen.findByRole("button", { name: "Reload page" })).toBeTruthy();
  expect(screen.queryByDisplayValue("private-token")).toBeNull();
  expect(screen.queryByText("Research")).toBeNull();
  expect(getMemberMcpConnections).toHaveBeenCalledTimes(1);
});

it("shows organization and no-auth states and allows removing an unavailable saved credential", async () => {
  const rows = [
    { ...connection, serverId: "shared", serverName: "Shared", status: "organization", credentialScope: "organization", credentialVersion: 0, canConnect: false },
    { ...connection, serverId: "public", serverName: "Public", status: "no_auth", authType: "none", credentialVersion: 0, canConnect: false },
    { ...connection, serverId: "old", serverName: "Old", status: "unavailable", credentialVersion: 2, hasCredential: true, canConnect: false }
  ] as const;
  vi.mocked(getMemberMcpConnections).mockResolvedValueOnce({ scope, connections: [...rows] })
    .mockResolvedValueOnce({ scope, connections: [rows[0], rows[1], { ...rows[2], credentialVersion: 3, hasCredential: false }] });
  render(<MemberMcpAccounts expectedScope={scope} />);
  expect(await screen.findByText("Organization account")).toBeTruthy();
  expect(screen.getByText("No account needed")).toBeTruthy();
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove credentials" }));
  expect(removeMemberMcpCredentials).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove now" }));
  await waitFor(() => expect(removeMemberMcpCredentials).toHaveBeenCalledWith("old", { scope, version: 2 }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove credentials" })).toBeNull());
});

it("keeps a draft after a save error and honors Cancel", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.mocked(saveMemberMcpCredentials).mockRejectedValueOnce(new Error("Could not save credentials"));
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "private-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not save credentials"));
  expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("private-token");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Secret")).toBeTruthy();
  expect(window.confirm).toHaveBeenCalledWith("Discard the credential you entered?");
});

it("clears secret consent on manual reload after a save failure", async () => {
  vi.mocked(saveMemberMcpCredentials).mockRejectedValueOnce(new Error("Network failure"));
  vi.mocked(getMemberMcpConnections).mockResolvedValueOnce({ scope, connections: [connection] })
    .mockResolvedValueOnce({ scope, connections: [{ ...connection, upstreamUrl: "https://changed.example.com/mcp", serverVersion: 5 }] });
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "old-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Network failure"));
  fireEvent.click(screen.getByRole("button", { name: "Reload connections" }));
  expect(await screen.findByText(/https:\/\/changed.example.com\/mcp/)).toBeTruthy();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("");
});
