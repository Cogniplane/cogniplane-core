// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it("preserves a later domain and directive while an earlier manual approval finishes", async () => {
  let finish!: (value: WidgetDomainsView) => void;
  vi.mocked(changeAdminMcpWidgetDomain).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  renderDomains();
  await screen.findByRole("list", { name: "Widget domains" });
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "https://first.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
  await waitFor(() => expect(changeAdminMcpWidgetDomain).toHaveBeenCalledExactlyOnceWith("research", "approve", { directive: "connectDomains", source: "https://first.example.com" }));
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "https://later.example.com" } });
  fireEvent.change(screen.getByLabelText("Used for"), { target: { value: "frameDomains" } });
  finish(asked);
  await waitFor(() => expect((screen.getByRole("button", { name: "Approve domain" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Domain") as HTMLInputElement).value).toBe("https://later.example.com");
  expect((screen.getByLabelText("Used for") as HTMLSelectElement).value).toBe("frameDomains");
  expect(screen.getByRole("status").textContent).toBe("Approved https://first.example.com for network requests. Later input stays in the form.");
});

it("makes no request while the row is closed, and loads when it opens", async () => {
  const { reopen } = renderDomains(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(getAdminMcpWidgetDomains).not.toHaveBeenCalled();
  reopen();
  expect(await screen.findByRole("list", { name: "Widget domains" })).toBeTruthy();
  expect(getAdminMcpWidgetDomains).toHaveBeenCalledExactlyOnceWith("research");
});

it("keeps Base URL capitalized in the approval confirmation and row action", async () => {
  vi.mocked(changeAdminMcpWidgetDomain).mockResolvedValue({ ...empty, approved: [{ directive: "baseUriDomains", source: "https://example.com:8443", approvedBy: "admin-a", approvedAt: "2026-11-04T12:00:00.000Z" }] });
  renderDomains();
  await screen.findByRole("list", { name: "Widget domains" });
  fireEvent.change(screen.getByLabelText("Used for"), { target: { value: "baseUriDomains" } });
  fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "https://example.com:8443" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve domain" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Approved https://example.com:8443 for Base URL."));
  expect(screen.getByRole("button", { name: "Remove https://example.com:8443 for Base URL" })).toBeTruthy();
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
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  expect(document.activeElement?.textContent).toContain("Saving this domain decision");
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
  expect(screen.getByRole("alert").closest("li")).toBeTruthy();
  await waitFor(() => expect(getAdminMcpWidgetDomains).toHaveBeenCalledTimes(2));
});

it.each([false, true])("reveals clipped row feedback after failure only while it owns focus, outside=%s", async (outside) => {
  let fail!: (reason: Error) => void;
  vi.mocked(changeAdminMcpWidgetDomain).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
  renderDomains();
  const button = await screen.findByRole("button", { name: "Approve https://api.vendor.com for network requests" });
  const feedback = button.closest("li")!.querySelector("p")!;
  const scroll = vi.fn();
  feedback.scrollIntoView = scroll;
  let top = 20;
  vi.spyOn(feedback, "getBoundingClientRect").mockImplementation(() => ({ top, bottom: top + 64 }) as DOMRect);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  try {
    button.focus(); fireEvent.click(button);
    expect(document.activeElement).toBe(feedback);
    expect(scroll).not.toHaveBeenCalled();
    const field = screen.getByLabelText("Domain");
    if (outside) field.focus();
    top = -6;
    await act(async () => { fail(new Error("Sample decision failed")); });
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(outside ? field : feedback);
    if (outside) expect(scroll).not.toHaveBeenCalled();
    else expect(scroll).toHaveBeenCalledWith({ block: "nearest", behavior: "instant" });
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it.each([false, true])("names a removed approval and preserves later input and focus, outside=%s", async (outside) => {
  const invalid = { directive: "connectDomains" as const, source: "https://old.example", approvedBy: "admin-a", approvedAt: "2026-11-04T12:00:00.000Z" };
  vi.mocked(getAdminMcpWidgetDomains).mockResolvedValue({ ...empty, approved: [invalid] });
  let finish!: (value: WidgetDomainsView) => void;
  vi.mocked(changeAdminMcpWidgetDomain).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  renderDomains();
  const button = await screen.findByRole("button", { name: "Remove https://old.example for network requests" });
  button.focus(); fireEvent.click(button);
  await waitFor(() => expect(changeAdminMcpWidgetDomain).toHaveBeenCalledExactlyOnceWith("research", "revoke", { directive: "connectDomains", source: "https://old.example" }));
  const field = screen.getByLabelText("Domain");
  if (outside) field.focus();
  fireEvent.change(field, { target: { value: "https://later.example.com" } });
  await act(async () => { finish(empty); });
  const result = screen.getByRole("status");
  await waitFor(() => expect(result.textContent).toBe("Removed approval for https://old.example for network requests."));
  expect(document.activeElement).toBe(outside ? field : result);
  expect((field as HTMLInputElement).value).toBe("https://later.example.com");
  expect(screen.queryByRole("list", { name: "Widget domains" })).toBeNull();
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
