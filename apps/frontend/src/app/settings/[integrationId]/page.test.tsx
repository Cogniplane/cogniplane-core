// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  integrationId: undefined as string | undefined,
  github: {
    status: null as null | Record<string, unknown>,
    busyKey: null,
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn()
  }
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ integrationId: state.integrationId }),
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  })
}));
vi.mock("../../../overlays", () => ({}));
vi.mock("../../../hooks/use-github-connection", () => ({
  useGithubConnection: () => state.github,
  useGithubRepositorySelection: () => ({
    repositories: [],
    truncated: false,
    isLoading: false,
    loadError: null,
    isSaving: false,
    saveError: null,
    saved: false,
    reload: vi.fn(),
    save: vi.fn()
  })
}));

import { notFound } from "next/navigation";

import SettingsSectionDetailPage from "./page";
import { registerSettingsSection } from "../settings-sections";

// Stand-ins for sections that an overlay registers at startup.
registerSettingsSection({
  id: "example-connector",
  label: "Example",
  kind: "integration",
  detail: () => <p>Example connector settings</p>
});
registerSettingsSection({ id: "example-without-detail", label: "Example without detail", kind: "integration" });

beforeEach(() => {
  state.integrationId = undefined;
  state.github.status = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

it("renders the detail of a core service", () => {
  state.integrationId = "github";
  state.github.status = { configured: true, tenantEnabled: true, userConnection: null };
  render(<SettingsSectionDetailPage />);

  expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
  expect(notFound).not.toHaveBeenCalled();
});

it("renders a core service that the organization turned off, so the page shows its disabled state", () => {
  state.integrationId = "github";
  state.github.status = { configured: true, tenantEnabled: false, userConnection: null };
  render(<SettingsSectionDetailPage />);

  expect(screen.getByText("GitHub is disabled by your organization")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Connect GitHub" }) as HTMLButtonElement).disabled).toBe(true);
});

it("renders the detail that an overlay registered", () => {
  state.integrationId = "example-connector";
  render(<SettingsSectionDetailPage />);

  expect(screen.getByText("Example connector settings")).toBeTruthy();
});

it.each([
  ["an unknown id", "unknown-connector"],
  ["a registered section without a detail", "example-without-detail"],
  ["a prefix of a registered id", "example"],
  ["a missing id", undefined]
])("shows the not-found page for %s", (_case, integrationId) => {
  state.integrationId = integrationId;

  expect(() => SettingsSectionDetailPage()).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expect(notFound).toHaveBeenCalledOnce();
});
