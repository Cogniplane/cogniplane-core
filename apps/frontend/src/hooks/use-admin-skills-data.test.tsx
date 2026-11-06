// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SkillImportResponse, AdminSkill, AdminSkillReleaseSnapshot, SkillMarketplaceCatalog, SkillMarketplaceEntry, TenantDetails } from "@cogniplane/shared-types";
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
  await waitFor(() => expect(hook.result.current.manifestState.status).toBe("ready"));
  return { ...hook, client };
}

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

  await waitFor(() => expect(result.current.catalogState).toMatchObject({ status: "failed", error: "Could not load the marketplace." }));
});

it("serializes entries and operations with a synchronous guard, then admits the next task", async () => {
  const first = pending<SkillImportResponse>();
  vi.mocked(api.importAdminSkillGithub).mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined as never);
  const { result } = await renderLoaded();
  let request!: Promise<unknown>;
  let refused!: Promise<unknown>;
  act(() => {
    request = result.current.handleMarketplaceImport(entry);
    refused = result.current.handleMarketplaceImport({ ...entry, slug: "csv" }).catch(error => error.message);
  });
  expect(await refused).toContain("Another skill operation is still pending");
  await waitFor(() => expect(result.current.busyKey).toBe("skill-import-marketplace-pdf"));
  expect(api.importAdminSkillGithub).toHaveBeenCalledTimes(1);
  await expect(result.current.handleSaveManifestUrl(null)).rejects.toThrow("Another skill operation");
  expect(api.updateTenantMarketplaceManifestUrl).not.toHaveBeenCalled();
  await act(async () => { first.resolve(undefined as never); await request; });
  await act(async () => { await result.current.handleMarketplaceImport({ ...entry, slug: "csv" }); });
  expect(api.importAdminSkillGithub).toHaveBeenCalledTimes(2);
  expect(result.current.busyKey).toBeNull();
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
  vi.mocked(api.updateTenantMarketplaceManifestUrl).mockResolvedValue({ ok: true, skillMarketplaceManifestUrl: null });
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleDisable("s1", snapshot).catch(() => undefined); });
  await waitFor(() => expect(result.current.error).toBe("Failed to disable skill."));

  await act(async () => { await result.current.handleSaveManifestUrl(null); });
  await waitFor(() => expect(result.current.error).toBeNull());
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
  vi.mocked(api.updateTenantMarketplaceManifestUrl).mockResolvedValue({ ok: true, skillMarketplaceManifestUrl: null });
  const { result } = await renderLoaded();

  await act(async () => { await result.current.handleSaveManifestUrl("https://example.com/new.json"); });

  await waitFor(() => {
    expect(api.getSkillMarketplace).toHaveBeenCalledTimes(2);
    expect(api.getTenantDetails).toHaveBeenCalledTimes(2);
  });
  expect(api.listAdminSkills).toHaveBeenCalledTimes(1);
});

it("keeps three initial reads distinct and never calls an unknown manifest empty", async () => {
  const load = pending<TenantDetails>();
  vi.mocked(api.getTenantDetails).mockReturnValue(load.promise);
  vi.mocked(api.getSkillMarketplace).mockRejectedValue(new Error("Catalog offline"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const { result } = renderHook(useAdminSkillsData, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  expect(result.current.manifestUrl).toBeUndefined();
  expect(result.current.manifestState.status).toBe("pending");
  await waitFor(() => expect(result.current.catalogState.status).toBe("failed"));
  expect(result.current.libraryState.status).toBe("ready");
  await act(async () => { load.resolve(tenant); });
  await waitFor(() => expect(result.current.manifestState.status).toBe("ready"));
  expect(result.current.catalogState.status).toBe("failed");
});

it("retains the library after its failed refresh and retries only the library", async () => {
  const { result } = await renderLoaded();
  vi.mocked(api.listAdminSkills).mockRejectedValueOnce(new Error("Library offline"));
  act(() => result.current.libraryState.retry());
  await waitFor(() => expect(result.current.libraryState.status).toBe("stale"));
  expect(result.current.skills).toEqual(skills);
  expect(result.current.catalogState.status).toBe("ready");
  expect(api.getSkillMarketplace).toHaveBeenCalledTimes(1);
  act(() => result.current.libraryState.retry());
  await waitFor(() => expect(result.current.libraryState.status).toBe("ready"));
  expect(api.listAdminSkills).toHaveBeenCalledTimes(3);
});
