// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillMarketplaceEntry } from "@cogniplane/shared-types";

import { AdminSkillMarketplaceTab } from "./admin-skill-marketplace-tab";

afterEach(cleanup);

const entry: SkillMarketplaceEntry = {
  slug: "pdf", name: "PDF tools", description: "Read and fill PDFs.", repositoryUrl: "https://github.com/o/r",
  ref: "0123456789abcdef", subdirectory: "skills/pdf", publisher: "Acme", reviewStatus: "reviewed",
  tags: ["documents"], recommended: true, skillVersion: "1.2.0", lastReviewedAt: null,
  sourceUrl: "https://github.com/o/r/tree/main/skills/pdf"
};
const common = { title: "Catalog", description: null, repositoryUrl: null, skills: [] };

function renderTab(props: Partial<Parameters<typeof AdminSkillMarketplaceTab>[0]> = {}) {
  const handlers = {
    onManifestUrlDraftChange: vi.fn(), onSaveManifestUrl: vi.fn(), onClearManifestUrl: vi.fn(),
    onImportMarketplace: vi.fn(async () => undefined)
  };
  render(<AdminSkillMarketplaceTab marketplace={null} manifestUrl={null} manifestUrlDraft="" busyKey={null} {...handlers} {...props} />);
  return handlers;
}

it("shows a loading line until the catalog arrives", () => {
  renderTab();

  expect(screen.getByText("Loading curated skills...")).toBeTruthy();
});

it("lists ready entries with their details and imports one", () => {
  const { onImportMarketplace } = renderTab({
    marketplace: { ...common, status: "ready", sourceUrl: "https://x/m.json", fetchedAt: "2026-10-01T00:00:00.000Z", error: null, skills: [entry] }
  });

  expect(screen.getByText("1 curated")).toBeTruthy();
  expect(screen.getByText("recommended")).toBeTruthy();
  expect(screen.getByText("skill v1.2.0")).toBeTruthy();
  // The commit ref is cut to 12 characters.
  expect(screen.getByText("0123456789ab")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View source" }).getAttribute("href")).toBe(entry.sourceUrl);

  fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
  expect(onImportMarketplace).toHaveBeenCalledWith(entry);
});

it("disables only the entry being imported", () => {
  renderTab({
    busyKey: "skill-import-marketplace-pdf",
    marketplace: { ...common, status: "ready", sourceUrl: "https://x/m.json", fetchedAt: "2026-10-01T00:00:00.000Z", error: null, skills: [entry, { ...entry, slug: "csv", name: "CSV tools" }] }
  });

  const buttons = screen.getAllByRole("button", { name: /Import/ }) as HTMLButtonElement[];
  expect(buttons.map((button) => [button.textContent, button.disabled])).toEqual([["Importing...", true], ["Import skill", false]]);
});

it("explains a disabled catalog and shows an error with its source", () => {
  renderTab({ marketplace: { ...common, status: "disabled", sourceUrl: null, fetchedAt: null, error: null } });
  expect(screen.getByText(/No marketplace manifest is configured yet/)).toBeTruthy();
  cleanup();

  renderTab({ marketplace: { ...common, status: "error", sourceUrl: "https://x/m.json", fetchedAt: "2026-10-01T00:00:00.000Z", error: "Manifest is not valid JSON." } });
  expect(screen.getByText("Manifest is not valid JSON.")).toBeTruthy();
  expect(screen.getByText("https://x/m.json")).toBeTruthy();
});

it("swallows a failed import, because the hook reports the error", async () => {
  // A plain function, not vi.fn: vi.fn records settled results, which attaches
  // a handler to the promise and would hide a missing catch.
  const imported: SkillMarketplaceEntry[] = [];
  const onImportMarketplace = (picked: SkillMarketplaceEntry) => {
    imported.push(picked);
    return Promise.reject(new Error("rate limited"));
  };
  renderTab({
    onImportMarketplace,
    marketplace: { ...common, status: "ready", sourceUrl: "https://x/m.json", fetchedAt: "2026-10-01T00:00:00.000Z", error: null, skills: [entry] }
  });

  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
    // Node reports an unhandled rejection after the microtasks drain.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", unhandled);
  }

  expect(imported).toEqual([entry]);
  expect(unhandled).not.toHaveBeenCalled();
});

it("passes edits, saves, and clears of the manifest URL to the page", () => {
  const handlers = renderTab({ manifestUrl: "https://x/m.json", manifestUrlDraft: "https://x/m.json" });

  fireEvent.change(screen.getByLabelText("Marketplace manifest URL"), { target: { value: "https://x/new.json" } });
  expect(handlers.onManifestUrlDraftChange).toHaveBeenCalledWith("https://x/new.json");

  fireEvent.submit(screen.getByLabelText("Marketplace manifest URL").closest("form")!);
  expect(handlers.onSaveManifestUrl).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(handlers.onClearManifestUrl).toHaveBeenCalledTimes(1);
});

it("enables Save only for a changed URL, and Clear only when a URL is saved", () => {
  renderTab({ manifestUrl: "https://x/m.json", manifestUrlDraft: " https://x/m.json " });
  expect((screen.getByRole("button", { name: "Save manifest URL" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  cleanup();

  renderTab({ manifestUrl: null, manifestUrlDraft: "https://x/new.json" });
  expect((screen.getByRole("button", { name: "Save manifest URL" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  cleanup();

  renderTab({ manifestUrl: "https://x/m.json", manifestUrlDraft: "https://x/new.json", busyKey: "skill-marketplace-manifest-url" });
  expect((screen.getByRole("button", { name: "Saving..." }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
});
