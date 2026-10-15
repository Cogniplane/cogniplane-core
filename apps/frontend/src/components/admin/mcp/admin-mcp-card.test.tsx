// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AdminMcpServer } from "@cogniplane/shared-types";

import { AdminMcpCard } from "./admin-mcp-card";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));

afterEach(cleanup);

it("opens the exact linked connection and leaves missing links safe", () => {
  const first = { serverId: "first", serverName: "First MCP", mode: "managed", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 } as AdminMcpServer;
  const second = { ...first, serverId: "second", serverName: "Second MCP", routePath: "/mcp/second" };
  const onSubmit = vi.fn(async () => undefined);
  const props = { mcpServers: [first, second], busyKey: null, onSubmit, onSetInheritedAudience: async () => undefined };
  const page = render(<AdminMcpCard {...props} targetServerId="second" />);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Second MCP");
  expect(document.activeElement).toBe(screen.getByRole("form", { name: "Manage Second MCP" }));
  expect(onSubmit).not.toHaveBeenCalled();
  page.unmount();
  render(<AdminMcpCard {...props} targetServerId="missing" />);
  expect(screen.getByRole("alert").textContent).toContain("no longer available");
  expect(screen.queryByRole("form", { name: /Manage/ })).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("shows both warnings and still submits a local HTTP MCP upstream", async () => {
  const onSubmit = vi.fn(async () => undefined);
  const server = {
    serverId: "local",
    serverName: "Local MCP",
    description: null,
    mode: "proxy",
    routePath: "/mcp/local",
    upstreamUrl: "http://100.108.24.234:3108/mcp",
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    transportKind: "http",
    enabled: true,
    isAllowed: true,
    isPublished: false,
    version: 1
  } as AdminMcpServer;

  render(
    <AdminMcpCard
      mcpServers={[server]}
      busyKey={null}
      onSubmit={onSubmit}
      onSetInheritedAudience={async () => undefined}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect(screen.getByText(/HTTP sends requests without encryption/)).toBeTruthy();
  expect(screen.getByText(/local or shared network/)).toBeTruthy();
  const submit = screen.getByRole("button", { name: "Save connection" });
  expect((submit as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ upstreamUrl: "http://100.108.24.234:3108/mcp" }),
    "local"
  ));
});

it("does not show an upstream URL for a managed server", () => {
  const server = {
    serverId: "managed",
    serverName: "Managed MCP",
    description: null,
    mode: "managed",
    routePath: "/mcp/managed",
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    transportKind: "http",
    enabled: true,
    isAllowed: true,
    isPublished: false,
    version: 1
  } as AdminMcpServer;

  render(
    <AdminMcpCard
      mcpServers={[server]}
      busyKey={null}
      onSubmit={async () => undefined}
      onSetInheritedAudience={async () => undefined}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect(screen.queryByLabelText("URL")).toBeNull();
  expect(screen.queryByText(/local or shared network/)).toBeNull();
});

it("derives connection routing and saves an explicit off audience", async () => {
  const onSubmit = vi.fn(async () => undefined);
  render(<AdminMcpCard mcpServers={[]} busyKey={null} onSubmit={onSubmit} onSetInheritedAudience={async () => undefined} />);

  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Research database" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/mcp" } });
  const submit = screen.getAllByRole("button", { name: "Add connection" }).find(
    (button) => (button as HTMLButtonElement).type === "submit"
  );
  expect(submit).toBeTruthy();
  fireEvent.click(submit!);

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      serverId: "research-database",
      routePath: "/mcp/research-database",
      upstreamUrl: "https://example.com/mcp",
      audience: "off"
    }),
    null
  ));
});

it("changes an inherited connection's tenant availability without editing system fields", async () => {
  const onSubmit = vi.fn(async () => undefined);
  const onSetInheritedAudience = vi.fn(async () => undefined);
  const server = {
    serverId: "built-in",
    ownerTenantId: "system",
    serverName: "Built-in",
    description: "System tools",
    mode: "managed",
    routePath: "/mcp/built-in",
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    transportKind: "http",
    enabled: true,
    isAllowed: true,
    isPublished: true,
    version: 1,
    configHash: "test",
    createdBy: "system",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as AdminMcpServer;

  render(<AdminMcpCard mcpServers={[server]} busyKey={null} onSubmit={onSubmit} onSetInheritedAudience={onSetInheritedAudience} />);
  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByLabelText("Route path") as HTMLInputElement).readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await waitFor(() => expect(onSetInheritedAudience).toHaveBeenCalledWith("built-in", "members"));
  expect(onSubmit).not.toHaveBeenCalled();
});

it("keeps organization accounts as the default for new proxy connections", async () => {
  const onSubmit = vi.fn(async () => undefined);
  render(<AdminMcpCard mcpServers={[]} busyKey={null} onSubmit={onSubmit} onSetInheritedAudience={async () => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  expect((screen.getByRole("radio", { name: "Organization account" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shared tools" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/mcp" } });
  const submit = screen.getAllByRole("button", { name: "Add connection" }).find((button) => (button as HTMLButtonElement).type === "submit")!;
  fireEvent.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ credentialScope: "organization" }), null));
});

it("requires authentication for each member and never asks the admin for a shared secret", async () => {
  const onSubmit = vi.fn(async () => undefined);
  const server = {
    serverId: "research", serverName: "Research", description: null, mode: "proxy",
    routePath: "/mcp/research", upstreamUrl: "https://example.com/mcp",
    upstreamAuthType: "bearer", upstreamAuthName: null, upstreamAuthConfigured: false,
    credentialScope: "personal", transportKind: "http", enabled: true, isAllowed: true,
    isPublished: false, version: 1
  } as AdminMcpServer;
  render(<AdminMcpCard mcpServers={[server]} busyKey={null} onSubmit={onSubmit} onSetInheritedAudience={async () => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect((screen.getByRole("radio", { name: "Each member connects" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByLabelText("Secret")).toBeNull();
  expect(screen.getByText(/Changing the URL or authentication method requires members to reconnect/)).toBeTruthy();
  expect(screen.getByText("authentication bearer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    credentialScope: "personal", upstreamAuthType: "bearer", upstreamAuthSecret: null
  }), "research"));
});

it("rejects personal scope without authentication", () => {
  const onSubmit = vi.fn(async () => undefined);
  render(<AdminMcpCard mcpServers={[]} busyKey={null} onSubmit={onSubmit} onSetInheritedAudience={async () => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.click(screen.getByRole("radio", { name: "Each member connects" }));
  expect(screen.getByRole("alert").textContent).toContain("Choose bearer token");
  expect((screen.getAllByRole("button", { name: "Add connection" }).find((button) => (button as HTMLButtonElement).type === "submit") as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("keeps the saved connection open so its test stays in reach", async () => {
  const server = { serverId: "first", serverName: "First MCP", mode: "managed", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: true, version: 2, configHash: "h" } as AdminMcpServer;
  const onSubmit = vi.fn(async () => undefined);
  render(<AdminMcpCard mcpServers={[server]} busyKey={null} onSubmit={onSubmit} onSetInheritedAudience={async () => undefined} />);
  expect(screen.getByText(/Available to members\. Not tested since the last save\./)).toBeTruthy();
  const manage = screen.getByRole("button", { name: "Manage First MCP" });
  fireEvent.click(manage);
  expect(manage.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  expect(manage.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Test saved version 2" }).closest("[hidden]")).toBeNull();
  expect(screen.getByRole("button", { name: "Edit settings" })).toBeTruthy();
});

it("gives each connection's open state to the extra content of its row", () => {
  const first = { serverId: "first", serverName: "First MCP", mode: "proxy", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 } as AdminMcpServer;
  const second = { ...first, serverId: "second", serverName: "Second MCP", routePath: "/mcp/second" };
  const renderServerExtras = vi.fn((server: AdminMcpServer, open: boolean) => <p>{server.serverId} {open ? "open" : "closed"}</p>);
  render(<AdminMcpCard mcpServers={[first, second]} busyKey={null} onSubmit={async () => undefined}
    onSetInheritedAudience={async () => undefined} renderServerExtras={renderServerExtras} />);
  expect(screen.getByText("first closed")).toBeTruthy();
  expect(screen.getByText("second closed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage Second MCP" }));
  expect(screen.getByText("second open")).toBeTruthy();
  expect(screen.getByText("first closed")).toBeTruthy();
});
