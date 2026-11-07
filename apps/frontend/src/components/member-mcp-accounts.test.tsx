// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { getMemberMcpConnections, removeMemberMcpCredentials, saveMemberMcpCredentials } from "@/lib/member-mcp-api";
import { MemberMcpAccounts } from "./member-mcp-accounts";

vi.mock("@/lib/member-mcp-api", () => ({
  getMemberMcpConnections: vi.fn(), saveMemberMcpCredentials: vi.fn(), removeMemberMcpCredentials: vi.fn()
}));
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

// A security change of the member's account suspended the saved
// credential. The backend sends `reconnect_required` with `suspended: true`.
// There is no confirm: the label is free text that the saver chose, and the
// page cannot show which account the secret belongs to.
const suspended = { ...connection, status: "reconnect_required" as const, suspended: true, credentialVersion: 3, hasCredential: true };

it("shows a suspended credential with only Replace secret and Remove, and no saver label", async () => {
  // An older backend can still send the label; the page must not attribute it to the member.
  vi.mocked(getMemberMcpConnections).mockResolvedValue({ scope, connections: [{ ...suspended, accountLabel: "Work" }] });
  render(<MemberMcpAccounts expectedScope={scope} />);
  expect(await screen.findByText("Suspended")).toBeTruthy();
  expect(screen.getByText("Suspended because your account security changed")).toBeTruthy();
  expect(screen.queryByText("Reconnect required")).toBeNull();
  expect(screen.queryByText(/entered by you/)).toBeNull();
  expect(screen.queryByText(/Work/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Replace secret" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove credentials" })).toBeTruthy();
});

it("restores a suspended credential only through a new secret", async () => {
  vi.mocked(getMemberMcpConnections).mockResolvedValue({ scope, connections: [suspended] });
  vi.mocked(saveMemberMcpCredentials).mockResolvedValue({ scope,
    connection: { ...suspended, status: "connected", suspended: undefined, credentialVersion: 4, accountLabel: null } });
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace secret" }));
  expect(screen.getByText("Replace your credential")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this endpoint and authentication method." }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "my-new-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  await waitFor(() => expect(saveMemberMcpCredentials).toHaveBeenCalledWith("research", {
    scope, version: 3, serverVersion: 4, secret: "my-new-token", accountLabel: null
  }));
  expect(await screen.findByText("Credentials saved")).toBeTruthy();
  expect(screen.queryByText("Suspended because your account security changed")).toBeNull();
});

it("keeps a binding rotation as Reconnect required, not Suspended", async () => {
  vi.mocked(getMemberMcpConnections).mockResolvedValue({ scope,
    connections: [{ ...connection, status: "reconnect_required", credentialVersion: 3, hasCredential: false, accountLabel: "Work" }] });
  render(<MemberMcpAccounts expectedScope={scope} />);
  expect(await screen.findByText("Reconnect required")).toBeTruthy();
  expect(screen.queryByText("Suspended because your account security changed")).toBeNull();
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
});

it("moves focus into credential review and returns it after cancel", async () => {
  render(<MemberMcpAccounts expectedScope={scope} />);
  const trigger = await screen.findByRole("button", { name: "Connect" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Connect your account" }));
  expect(screen.queryByLabelText("Secret")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("keeps removal pending and errors local, then returns focus after removal", async () => {
  const connected = { ...connection, status: "connected" as const, credentialVersion: 2, hasCredential: true };
  vi.mocked(getMemberMcpConnections).mockResolvedValueOnce({ scope, connections: [connected] }).mockResolvedValueOnce({ scope, connections: [connection] });
  let reject!: (reason: Error) => void;
  vi.mocked(removeMemberMcpCredentials).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  render(<MemberMcpAccounts expectedScope={scope} />);
  const trigger = await screen.findByRole("button", { name: "Remove credentials" });
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Remove your saved credential for Research?" }));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Keep credential" }));
  expect(document.activeElement).toBe(trigger);
  expect(removeMemberMcpCredentials).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Remove now" }));
  expect((await screen.findByRole("button", { name: "Removing..." }) as HTMLButtonElement).disabled).toBe(true);
  reject(new Error("Removal unavailable"));
  const alert = await screen.findByRole("alert");
  expect(alert.closest('[role="group"]')?.getAttribute("aria-labelledby")).toBe("member-mcp-remove-title-research");
  fireEvent.click(screen.getByRole("button", { name: "Remove now" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Connect" })));
  expect(screen.queryByRole("button", { name: "Remove now" })).toBeNull();
});

it("uses the section as a focus fallback when a removed connection leaves the list", async () => {
  vi.mocked(getMemberMcpConnections).mockResolvedValueOnce({ scope, connections: [{ ...connection, hasCredential: true }] }).mockResolvedValueOnce({ scope, connections: [] });
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove credentials" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove now" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Organization MCP connections" })));
});

it("refuses a secret over the maximum even if a scripted change bypasses input limits", async () => {
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "x".repeat(8193) } });
  expect((screen.getByLabelText("Secret") as HTMLInputElement).maxLength).toBe(8192);
  expect((screen.getByRole("button", { name: "Save credentials" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  expect(saveMemberMcpCredentials).not.toHaveBeenCalled();
});

it.each([403, 404])("clears a secret and disables entry if a %s refresh removes permission", async (status) => {
  vi.mocked(getMemberMcpConnections).mockResolvedValueOnce({ scope, connections: [connection] }).mockResolvedValueOnce({ scope, connections: [{ ...connection, canConnect: false, status: "unavailable" }] });
  vi.mocked(saveMemberMcpCredentials).mockRejectedValueOnce(new ApiError({ status, method: "PUT", path: "/synthetic-only", message: "Sample permission changed" }));
  render(<MemberMcpAccounts expectedScope={scope} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "sample-secret-only" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credentials" }));
  await screen.findByText(/no longer available for new credentials/);
  expect(screen.queryByDisplayValue("sample-secret-only")).toBeNull();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  expect((screen.getByRole("checkbox", { name: /I reviewed/ }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save credentials" }) as HTMLButtonElement).disabled).toBe(true);
  expect(saveMemberMcpCredentials).toHaveBeenCalledOnce();
});
