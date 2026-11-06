// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminMcpServer } from "@cogniplane/shared-types";

import { listAdminMcpServers } from "@/lib/admin-api";
import { queryKeys } from "@/lib/query-keys";
import { AdminMcpContent } from "./admin-mcp-content";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "sample", userId: "sample-admin" } }) }));
vi.mock("@/lib/admin-api", async (original) => ({ ...await original<object>(), listAdminMcpServers: vi.fn() }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each([false, true])("keeps initial Reload mounted through the real query transition, outside focus=%s", async (outside) => {
  let finish!: (servers: AdminMcpServer[]) => void;
  vi.mocked(listAdminMcpServers).mockRejectedValueOnce(new Error("Sample list unavailable"))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(<QueryClientProvider client={client}><AdminMcpContent /><button>Outside sample</button></QueryClientProvider>);
  const button = await screen.findByRole("button", { name: "Reload" });
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(listAdminMcpServers).toHaveBeenCalledTimes(2));
  // TanStack clears an initial error while retrying. Keep the initiating control.
  expect(client.getQueryState(queryKeys.admin.mcpServers())?.error).toBeNull();
  expect(screen.getByRole("button", { name: "Reloading…" })).toBe(button);
  expect(document.activeElement).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(button.getAttribute("aria-busy")).toBe("true");
  if (outside) screen.getByRole("button", { name: "Outside sample" }).focus();
  await act(async () => { finish([]); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Reloading…" })).toBeNull());
  expect(document.activeElement).toBe(outside ? screen.getByRole("button", { name: "Outside sample" }) : screen.getByRole("heading", { name: "MCP connections" }));
  expect(screen.getByText("No connections yet.")).toBeTruthy();
  client.clear();
});
