// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminSkill, AdminSkillReleaseSnapshot, SkillMarketplaceCatalog, SkillMarketplaceEntry, TenantDetails } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import * as api from "../lib/admin-api";
import { useAdminSkillsData } from "./use-admin-skills-data";

vi.mock("../lib/admin-api", () => ({
  activateSkillRevision: vi.fn(), disableAdminSkill: vi.fn(), getSkillMarketplace: vi.fn(),
  getTenantDetails: vi.fn(), importAdminSkillGithub: vi.fn(), importAdminSkillInline: vi.fn(),
  importAdminSkillZip: vi.fn(), listAdminSkills: vi.fn(), listSkillRevisions: vi.fn(),
  publishAdminSkill: vi.fn(), unpublishAdminSkill: vi.fn(), updateTenantMarketplaceManifestUrl: vi.fn()
}));

const skills = [{ skillId: "s1" }] as unknown as AdminSkill[];
const marketplace = { skills: [] } as unknown as SkillMarketplaceCatalog;
const tenant = { settings: { skillMarketplaceManifestUrl: "https://example.com/m.json" } } as unknown as TenantDetails;
const entry = { slug: "pdf", name: "PDF tools", repositoryUrl: "https://github.com/o/r", ref: "main", subdirectory: "pdf" } as SkillMarketplaceEntry;
const snapshot = {} as AdminSkillReleaseSnapshot;

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(api.listAdminSkills).mockResolvedValue(skills);
  vi.mocked(api.getSkillMarketplace).mockResolvedValue(marketplace);
  vi.mocked(api.getTenantDetails).mockResolvedValue(tenant);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
});

async function renderLoaded() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(useAdminSkillsData, { wrapper });
  await waitFor(() => expect(hook.result.current.manifestUrl).not.toBeNull());
  return { ...hook, client };
}

// TanStack Query delivers observer updates on a zero-delay timer. Flush it
// before asserting that a value did NOT change.
const flushQueryNotifications = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

it("returns the loaded skills, marketplace, and manifest URL", async () => {
  const { result } = await renderLoaded();

  expect(result.current).toMatchObject({
    skills, skillsLoaded: true, marketplace, manifestUrl: "https://example.com/m.json", busyKey: null, error: null
  });
});

it("shows the load fallback when a query fails without an Error", async () => {
  vi.mocked(api.getSkillMarketplace).mockRejectedValue("offline");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(useAdminSkillsData, { wrapper });

  await waitFor(() => expect(result.current.error).toBe("Failed to load skills."));
});

type Hook = ReturnType<typeof useAdminSkillsData>;

it("names the busy mutation by priority and moves to the next as each one settles", async () => {
  const byPriority = [
    ["skill-import-zip", api.importAdminSkillZip, (h: Hook) => h.handleZipImport(new File([], "s.zip"))],
    ["skill-import-github", api.importAdminSkillGithub, (h: Hook) => h.handleGithubImport({ githubUrl: "https://github.com/o/r" })],
    ["skill-import-inline", api.importAdminSkillInline, (h: Hook) => h.handleInlineImport({ skillId: "s2", skillName: "S2", description: "", instructions: "" })],
    ["skill-import-marketplace-pdf", api.importAdminSkillGithub, (h: Hook) => h.handleMarketplaceImport(entry)],
    ["activate-skill-s1-7", api.activateSkillRevision, (h: Hook) => h.handleActivateRevision({ skillId: "s1", skillRevisionId: 7, expectedSnapshot: snapshot })],
    ["publish-skill-s1", api.publishAdminSkill, (h: Hook) => h.handlePublish("s1", snapshot)],
    ["unpublish-skill-s2", api.unpublishAdminSkill, (h: Hook) => h.handleUnpublish("s2", snapshot)],
    ["disable-skill-s3", api.disableAdminSkill, (h: Hook) => h.handleDisable("s3", snapshot)],
    ["skill-marketplace-manifest-url", api.updateTenantMarketplaceManifestUrl, (h: Hook) => h.handleSaveManifestUrl(null)]
  ] as const;
  // Start the lowest priority first, so the result cannot come from start order.
  const startOrder = [...byPriority].reverse();
  const gates = new Map(startOrder.map(([key, apiCall]) => {
    const gate = pending<never>();
    vi.mocked(apiCall).mockReturnValueOnce(gate.promise);
    return [key, gate] as const;
  }));
  const { result } = await renderLoaded();

  act(() => { for (const [, , start] of startOrder) void start(result.current).catch(() => undefined); });

  for (const [key] of byPriority) {
    await waitFor(() => expect(result.current.busyKey).toBe(key));
    await act(async () => { gates.get(key)!.resolve(undefined as never); });
  }
  await waitFor(() => expect(result.current.busyKey).toBeNull());
});

it("shows the fallback when a mutation rejects with a falsy value", async () => {
  vi.mocked(api.importAdminSkillZip).mockRejectedValue("");
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleZipImport(new File([], "s.zip")).catch(() => undefined); });

  await waitFor(() => expect(result.current.error).toBe("Failed to import zip skill bundle."));
});

it("shows the latest action's failure, clears it when a new action starts, and recovers on retry", async () => {
  vi.mocked(api.importAdminSkillGithub).mockRejectedValue("bad");
  const publish = pending<never>();
  vi.mocked(api.publishAdminSkill).mockReturnValueOnce(publish.promise).mockResolvedValueOnce(undefined as never);
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleMarketplaceImport(entry).catch(() => undefined); });
  await waitFor(() => expect(result.current.error).toBe("Failed to import PDF tools from the marketplace."));

  let published!: Promise<unknown>;
  act(() => { published = result.current.handlePublish("s1", snapshot).catch(() => undefined); });
  await waitFor(() => expect(result.current.busyKey).toBe("publish-skill-s1"));
  expect(result.current.error).toBeNull();

  await act(async () => { publish.resolve(Promise.reject(new Error("Snapshot is stale.")) as never); await published; });
  await waitFor(() => expect(result.current.error).toBe("Snapshot is stale."));

  await act(async () => { await result.current.handlePublish("s1", snapshot); });
  await waitFor(() => expect(result.current.error).toBeNull());
});

it("clears an earlier failure after a different action succeeds", async () => {
  vi.mocked(api.disableAdminSkill).mockRejectedValue("bad");
  vi.mocked(api.updateTenantMarketplaceManifestUrl).mockResolvedValue(undefined as never);
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleDisable("s1", snapshot).catch(() => undefined); });
  await waitFor(() => expect(result.current.error).toBe("Failed to disable skill."));

  await act(async () => { await result.current.handleSaveManifestUrl(null); });
  await waitFor(() => expect(result.current.error).toBeNull());
});

it("does not let an older action that fails later replace the newer action's result", async () => {
  const publish = pending<never>();
  const zipImport = pending<never>();
  vi.mocked(api.publishAdminSkill).mockReturnValue(publish.promise);
  vi.mocked(api.importAdminSkillZip).mockReturnValue(zipImport.promise);
  const { result, client } = await renderLoaded();

  let published!: Promise<unknown>;
  let imported!: Promise<unknown>;
  act(() => { published = result.current.handlePublish("s1", snapshot).catch(() => undefined); });
  act(() => { imported = result.current.handleZipImport(new File([], "s.zip")).catch(() => undefined); });

  await act(async () => { publish.resolve(Promise.reject(new Error("Snapshot is stale.")) as never); await published; });
  await waitFor(() => expect(client.getMutationCache().getAll().filter((m) => m.state.status === "error")).toHaveLength(1));
  await flushQueryNotifications();
  expect(result.current.error).toBeNull();

  await act(async () => { zipImport.resolve(Promise.reject("") as never); await imported; });
  await waitFor(() => expect(result.current.error).toBe("Failed to import zip skill bundle."));
});

it("reports a failed disable with its own fallback", async () => {
  vi.mocked(api.disableAdminSkill).mockRejectedValue("bad");
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleDisable("s1", snapshot).catch(() => undefined); });

  await waitFor(() => expect(result.current.error).toBe("Failed to disable skill."));
});

it("reloads skills after a failed activation, because the revision may have committed", async () => {
  vi.mocked(api.activateSkillRevision).mockRejectedValue(new Error("audit write failed"));
  const { result } = await renderLoaded();
  expect(api.listAdminSkills).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.handleActivateRevision({ skillId: "s1", skillRevisionId: 7, expectedSnapshot: snapshot }).catch(() => undefined);
  });

  await waitFor(() => expect(api.listAdminSkills).toHaveBeenCalledTimes(2));
  expect(result.current.error).toBe("audit write failed");
});

it("reloads the marketplace and tenant after the manifest URL changes", async () => {
  vi.mocked(api.updateTenantMarketplaceManifestUrl).mockResolvedValue(undefined as never);
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleSaveManifestUrl("https://example.com/new.json"); });

  await waitFor(() => {
    expect(api.getSkillMarketplace).toHaveBeenCalledTimes(2);
    expect(api.getTenantDetails).toHaveBeenCalledTimes(2);
  });
  expect(api.listAdminSkills).toHaveBeenCalledTimes(1);
});
