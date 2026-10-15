// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminMcpServer } from "@cogniplane/shared-types";

import { AdminMcpContent } from "./admin-mcp-content";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
const base = { routePath: "/mcp/x", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 };
const servers = [
  { ...base, serverId: "proxy-one", serverName: "Proxy one", mode: "proxy" },
  { ...base, serverId: "managed-one", serverName: "Managed one", mode: "managed" }
] as AdminMcpServer[];
vi.mock("../../../hooks/use-admin-mcp-data", () => ({
  useAdminMcpData: () => ({ mcpServers: servers, loading: false, loaded: true, reload: vi.fn(), busyKey: null, loadError: null,
    saveError: null, handleSubmit: vi.fn(), handleSetInheritedAudience: vi.fn() })
}));
vi.mock("./admin-mcp-widget-domains", () => ({
  AdminMcpWidgetDomains: ({ server, open }: { server: AdminMcpServer; open: boolean }) =>
    <p data-testid="widget-domains">{server.serverId} {open ? "open" : "closed"}</p>
}));

afterEach(cleanup);

it("shows widget domains for a proxy connection only, and opens them with the row", () => {
  render(<AdminMcpContent />);
  const shown = screen.getAllByTestId("widget-domains");
  expect(shown.map((node) => node.textContent)).toEqual(["proxy-one closed"]);
  fireEvent.click(screen.getByRole("button", { name: "Manage Proxy one" }));
  expect(screen.getByTestId("widget-domains").textContent).toBe("proxy-one open");
  fireEvent.click(screen.getByRole("button", { name: "Manage Managed one" }));
  expect(screen.getByTestId("widget-domains").textContent).toBe("proxy-one closed");
});
