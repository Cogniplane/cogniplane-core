// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminMcpServer } from "@cogniplane/shared-types";
import { AdminMcpContent } from "../../../components/admin/mcp/admin-mcp-content";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));

const servers = [
  { serverId: "first", serverName: "First MCP", mode: "managed", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 },
  { serverId: "second", serverName: "Second MCP", mode: "managed", routePath: "/mcp/second", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 }
] as AdminMcpServer[];
vi.mock("../../../hooks/use-admin-mcp-data", () => ({ useAdminMcpData: () => ({ mcpServers: servers, loading: false, loaded: true, reload: vi.fn(), busyKey: null, loadError: null, saveError: null, handleSubmit: vi.fn(), handleSetInheritedAudience: vi.fn() }) }));

afterEach(cleanup);

it("switches the open editor when the target URL changes on the mounted page", () => {
  const page = render(<AdminMcpContent targetServerId="first" />);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("First MCP");
  page.rerender(<AdminMcpContent targetServerId="second" />);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Second MCP");
  page.rerender(<AdminMcpContent targetServerId="missing" />);
  expect(screen.getByRole("alert").textContent).toContain("no longer available");
  expect(screen.queryByLabelText("Name")).toBeNull();
});
