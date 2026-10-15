// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminMcpServer, AdminMcpWidgetDomains as WidgetDomainsView } from "@cogniplane/shared-types";
import { CSP_SOURCE_VECTORS } from "@cogniplane/shared-types/csp-source-vectors";

import { changeAdminMcpWidgetDomain, getAdminMcpWidgetDomains } from "@/lib/admin-api";
import { ApiError } from "@/lib/api-client";
import { AdminMcpWidgetDomains } from "./admin-mcp-widget-domains";

vi.mock("@/lib/admin-api", () => ({ getAdminMcpWidgetDomains: vi.fn(), changeAdminMcpWidgetDomain: vi.fn() }));

const server = { serverId: "research", serverName: "Research", mode: "proxy" } as AdminMcpServer;
const empty: WidgetDomainsView = { serverId: "research", approved: [], requested: [] };
const asked: WidgetDomainsView = {
  serverId: "research",
  approved: [{ directive: "resourceDomains", source: "https://cdn.vendor.com", approvedBy: "admin-a", approvedAt: "2026-10-12T10:00:00.000Z" }],
  requested: [
    { directive: "connectDomains", source: "https://api.vendor.com", firstSeenAt: "2026-10-13T10:00:00.000Z", lastSeenAt: "2026-10-14T09:00:00.000Z" },
    { directive: "resourceDomains", source: "https://cdn.vendor.com", firstSeenAt: "2026-10-11T10:00:00.000Z", lastSeenAt: "2026-10-12T09:00:00.000Z" }
  ]
};

function renderDomains(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = render(<QueryClientProvider client={client}><AdminMcpWidgetDomains server={server} open={open} /></QueryClientProvider>);
  return { ...page, client, reopen: () => page.rerender(<QueryClientProvider client={client}><AdminMcpWidgetDomains server={server} open /></QueryClientProvider>) };
}

beforeEach(() => {
  vi.mocked(getAdminMcpWidgetDomains).mockResolvedValue(asked);
  vi.mocked(changeAdminMcpWidgetDomain).mockResolvedValue(asked);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("makes no request while the row is closed, and loads when it opens", async () => {
  const { reopen } = renderDomains(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(getAdminMcpWidgetDomains).not.toHaveBeenCalled();
  reopen();
  expect(await screen.findByRole("list", { name: "Widget domains" })).toBeTruthy();
  expect(getAdminMcpWidgetDomains).toHaveBeenCalledExactlyOnceWith("research");
});

it("says that nothing is approved at the start and that a request appears after a view opens", async () => {
  vi.mocked(getAdminMcpWidgetDomains).mockResolvedValue(empty);
  renderDomains();
  expect(await screen.findByText(/No view from this connection has asked for an outside domain yet/)).toBeTruthy();
  expect(screen.getByText(/Nothing is approved until you do it/)).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Widget domains" })).toBeNull();
});

it("shows what widgets asked for, so the administrator can approve it", async () => {
  renderDomains();
  const list = await screen.findByRole("list", { name: "Widget domains" });
  const items = within(list).getAllByRole("listitem");
  // A request that waits for a decision comes before an approved one.
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toContain("https://api.vendor.com");
  expect(items[0]!.textContent).toContain("Network requests");
  expect(items[0]!.textContent).toContain("Waiting for approval");
  expect(items[0]!.textContent).toContain("Last requested");
  expect(items[1]!.textContent).toContain("https://cdn.vendor.com");
  expect(items[1]!.textContent).toContain("Scripts, styles, images, fonts and media");
  expect(items[1]!.textContent).toContain("Approved");
  expect(screen.getByRole("button", { name: "Approve https://api.vendor.com for network requests" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove https://cdn.vendor.com for scripts, styles, images, fonts and media" })).toBeTruthy();
});

it("approves a requested domain for its own source list only", async () => {
  const approved: WidgetDomainsView = {
    ...asked,
    approved: [...asked.approved, { directive: "connectDomains", source: "https://api.vendor.com", approvedBy: "admin-a", approvedAt: "2026-10-14T10:00:00.000Z" }]
  };
  vi.mocked(changeAdminMcpWidgetDomain).mockResolvedValue(approved);
  renderDomains();
  fireEvent.click(await screen.findByRole("button", { name: "Approve https://api.vendor.com for network requests" }));
  await waitFor(() => expect(changeAdminMcpWidgetDomain).toHaveBeenCalledExactlyOnceWith(
    "research", "approve", { directive: "connectDomains", source: "https://api.vendor.com" }
  ));
  // The list shows the saved answer without another request.
  expect(await screen.findByRole("button", { name: "Remove https://api.vendor.com for network requests" })).toBeTruthy();
  expect(getAdminMcpWidgetDomains).toHaveBeenCalledTimes(1);
});

it("removes an approval", async () => {
  vi.mocked(changeAdminMcpWidgetDomain).mockResolvedValue({ ...asked, approved: [] });
  renderDomains();
  fireEvent.click(await screen.findByRole("button", { name: /^Remove https:\/\/cdn\.vendor\.com/ }));
  await waitFor(() => expect(changeAdminMcpWidgetDomain).toHaveBeenCalledExactlyOnceWith(
    "research", "revoke", { directive: "resourceDomains", source: "https://cdn.vendor.com" }
  ));
  expect(await screen.findByRole("button", { name: /^Approve https:\/\/cdn\.vendor\.com/ })).toBeTruthy();
});

it("disables the buttons while a change is saving, then shows the saved list", async () => {
  let finish!: (value: WidgetDomainsView) => void;
  vi.mocked(changeAdminMcpWidgetDomain).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  renderDomains();
  const button = await screen.findByRole("button", { name: "Approve https://api.vendor.com for network requests" });
  fireEvent.click(button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("button", { name: "Approve domain" }) as HTMLButtonElement).disabled).toBe(true);
  finish(asked);
  await waitFor(() => expect((screen.getByRole("button", { name: "Approve domain" }) as HTMLButtonElement).disabled).toBe(false));
});

it("shows the server's message when a change fails, and reloads the saved list", async () => {
  vi.mocked(changeAdminMcpWidgetDomain).mockRejectedValue(new ApiError({
    status: 400, code: "invalid_config", method: "POST", path: "/x", message: "A server can have at most 200 approved domains. Remove one first."
  }));
  renderDomains();
  fireEvent.click(await screen.findByRole("button", { name: "Approve https://api.vendor.com for network requests" }));
  expect((await screen.findByRole("alert")).textContent).toContain("at most 200 approved domains");
  await waitFor(() => expect(getAdminMcpWidgetDomains).toHaveBeenCalledTimes(2));
});

it("adds a domain that was not requested, in normal form, for the chosen source list", async () => {
  renderDomains();
  await screen.findByRole("list", { name: "Widget domains" });
  fireEvent.change(screen.getByLabelText("Used for"), { target: { value: "frameDomains" } });
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: " HTTPS://Embed.Vendor.com:443 " } });
  fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
  await waitFor(() => expect(changeAdminMcpWidgetDomain).toHaveBeenCalledExactlyOnceWith(
    "research", "approve", { directive: "frameDomains", source: "https://embed.vendor.com" }
  ));
  await waitFor(() => expect((screen.getByLabelText("Domain") as HTMLInputElement).value).toBe(""));
});

it("keeps what was typed when the server refuses it", async () => {
  vi.mocked(changeAdminMcpWidgetDomain).mockRejectedValue(new Error("The domain could not be approved."));
  renderDomains();
  await screen.findByRole("list", { name: "Widget domains" });
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "https://embed.vendor.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
  expect((await screen.findByRole("alert")).textContent).toContain("could not be approved");
  expect((screen.getByLabelText("Domain") as HTMLInputElement).value).toBe("https://embed.vendor.com");
});

it.each(CSP_SOURCE_VECTORS.filter((vector) => vector.directive === "connectDomains" && vector.reason !== null && vector.reason !== "too_long")
  .map((vector) => [vector.name, vector] as const))(
  "does not send %s, and says why",
  async (_name, vector) => {
    renderDomains();
    await screen.findByRole("list", { name: "Widget domains" });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: vector.source } });
    fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
    const message = await screen.findByRole("alert");
    expect(message.textContent!.length).toBeGreaterThan(10);
    expect(screen.getByLabelText("Domain").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Domain").getAttribute("aria-describedby")).toBe(message.id);
    expect(changeAdminMcpWidgetDomain).not.toHaveBeenCalled();
  }
);

it("explains a wildcard on a public suffix in plain words", async () => {
  renderDomains();
  await screen.findByRole("list", { name: "Widget domains" });
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "https://*.co.uk" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
  expect((await screen.findByRole("alert")).textContent).toContain("cannot cover a public suffix");
});

it("clears the message when the person edits the field", async () => {
  renderDomains();
  await screen.findByRole("list", { name: "Widget domains" });
  fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Enter a source");
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "h" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows a load error with a reload button", async () => {
  vi.mocked(getAdminMcpWidgetDomains).mockRejectedValueOnce("offline");
  renderDomains();
  expect((await screen.findByRole("alert")).textContent).toBe("Failed to load widget domains.");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(await screen.findByRole("list", { name: "Widget domains" })).toBeTruthy();
});
