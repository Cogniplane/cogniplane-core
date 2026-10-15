// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminMcpServer, AdminSkill } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import { listAdminMcpServers, listAdminSkills } from "../lib/admin-api";
import { useAdminOverviewData } from "./use-admin-overview-data";

vi.mock("../lib/admin-api", () => ({ listAdminMcpServers: vi.fn(), listAdminSkills: vi.fn() }));

function skill(skillId: string, enabled: boolean): AdminSkill {
  return {
    skillId, skillName: skillId, description: null, instructions: "", version: 1, contentHash: "h", enabled,
    isPublished: true, createdBy: "u1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    activeRevisionId: null, activeSourceType: null, activeBundleName: null, activeBundleStorageUri: null,
    activeBundleHash: null, activeValidationStatus: null, activeReviewStatus: null, isInherited: false
  };
}

function server(serverId: string): AdminMcpServer {
  return {
    serverId, serverName: serverId, description: null, transportKind: "http", mode: "managed",
    routePath: `/mcp/${serverId}`, upstreamUrl: null, upstreamAuthType: "none", upstreamAuthName: null,
    upstreamAuthConfigured: false, version: 1, configHash: "h", enabled: true, isPublished: true,
    createdBy: "u1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
  };
}

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(listAdminSkills).mockResolvedValue([skill("pdf", true), skill("csv", false), skill("ocr", true)]);
  vi.mocked(listAdminMcpServers).mockResolvedValue([server("docs"), server("search")]);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(useAdminOverviewData, { wrapper });
}

it("counts zero until the lists load", () => {
  const { result } = renderOverview();

  expect(result.current).toEqual({ skillsCount: 0, enabledSkillsCount: 0, mcpServersCount: 0, error: null });
});

it("counts all skills, enabled skills, and MCP servers", async () => {
  const { result } = renderOverview();

  await waitFor(() => expect(result.current).toEqual({ skillsCount: 3, enabledSkillsCount: 2, mcpServersCount: 2, error: null }));
});

it("reports the skills error ahead of the MCP error", async () => {
  vi.mocked(listAdminSkills).mockRejectedValue(new Error("Skills are down."));
  vi.mocked(listAdminMcpServers).mockRejectedValue(new Error("MCP is down."));
  const { result } = renderOverview();

  await waitFor(() => expect(result.current.error).toBe("Skills are down."));
});

it("keeps the counts that loaded and reports the other list's failure with the fallback", async () => {
  vi.mocked(listAdminMcpServers).mockRejectedValue("offline");
  const { result } = renderOverview();

  await waitFor(() => expect(result.current.error).toBe("Failed to load overview data."));
  expect(result.current).toMatchObject({ skillsCount: 3, enabledSkillsCount: 2, mcpServersCount: 0 });
});
