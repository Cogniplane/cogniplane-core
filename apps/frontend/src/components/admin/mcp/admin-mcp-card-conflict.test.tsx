// @vitest-environment jsdom

// The connection editor saves a full draft. It sends the saved version that
// the draft started from, and it never takes a newer version on its own: the
// admin compares the newer saved values with the draft and chooses.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AdminMcpServer } from "@cogniplane/shared-types";

import { ApiError } from "@/lib/api-client";
import { AdminMcpCard } from "./admin-mcp-card";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
afterEach(cleanup);

const opened: AdminMcpServer = {
  serverId: "vendor", ownerTenantId: "tenant-a", serverName: "Vendor tools", description: "Vendor search",
  mode: "proxy", routePath: "/mcp/vendor", upstreamUrl: "https://vendor.example/mcp", upstreamAuthType: "bearer",
  upstreamAuthName: null, upstreamAuthConfigured: true, credentialScope: "organization", transportKind: "http",
  credentialBindingId: "binding-1", enabled: true, isAllowed: true, isPublished: true, version: 3,
  configHash: "a".repeat(64), createdBy: "admin-a", createdAt: "2026-11-04T12:00:00.000Z", updatedAt: "2026-11-04T12:00:00.000Z"
};
/** Admin B turned the connection off and moved it after a compromise. */
const disabledByB: AdminMcpServer = {
  ...opened, version: 5, enabled: false, isAllowed: false, isPublished: false,
  upstreamUrl: "https://replacement.example/mcp", credentialBindingId: "binding-2", configHash: "b".repeat(64)
};
const conflict = () => new ApiError({
  status: 409, code: "mcp_server_conflict", method: "PUT", path: "/admin/mcp-servers/vendor/setup",
  message: "This connection changed after you opened it. Review the saved connection before you save again."
});

type CardProps = Parameters<typeof AdminMcpCard>[0];
function renderCard(overrides: Partial<CardProps> = {}) {
  let props: CardProps = {
    mcpServers: [opened], busyKey: null, targetServerId: "vendor",
    onSubmit: vi.fn(async () => undefined), onSetInheritedAudience: vi.fn(async () => undefined),
    ...overrides
  };
  const view = render(<AdminMcpCard {...props} />);
  return {
    props,
    /** A new list from the server, as after a refetch. */
    list: (mcpServers: AdminMcpServer[]) => { props = { ...props, mcpServers }; view.rerender(<AdminMcpCard {...props} />); }
  };
}

const description = () => screen.getByLabelText("Description") as HTMLTextAreaElement;
const url = () => screen.getByLabelText("URL") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement;
const review = () => screen.getByRole("region", { name: "A newer version of this connection is saved" });

it("sends the saved version that the draft started from with an edit, and none with a create", async () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => undefined);
  renderCard({ onSubmit });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Edited by A", audience: "members" }),
    { serverId: "vendor", expectedVersion: 3 }
  ));

  fireEvent.click(await screen.findByRole("button", { name: "Add connection" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New tools" } });
  fireEvent.change(url(), { target: { value: "https://new.example/mcp" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Add connection" }).at(-1)!);
  await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ serverId: "new-tools" }), null));
});

it("keeps the draft after a 409 and shows the newer saved values beside it before any second save", async () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => { throw conflict(); });
  const card = renderCard({ onSubmit });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  // The page reloads the list after every save attempt.
  card.list([disabledByB]);

  const panel = await screen.findByRole("region", { name: "A newer version of this connection is saved" });
  expect(within(panel).getByRole("alert").textContent).toBe(
    "Version 5 was saved after you opened version 3. Your draft is kept. Compare the changed settings, then choose the values to keep."
  );
  const rows = within(panel).getAllByRole("row").map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));
  expect(rows).toEqual([
    ["Setting", "Saved now", "Your draft"],
    ["URL", "https://replacement.example/mcp", "https://vendor.example/mcp"],
    ["Availability", "Off", "All members"]
  ]);
  expect(description().value).toBe("Edited by A");
  expect(url().value).toBe("https://vendor.example/mcp");
  expect(saveButton().disabled).toBe(true);
  fireEvent.submit(screen.getByRole("form"));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("saves the kept draft against the newer version only after Keep my draft", async () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => { throw conflict(); });
  const card = renderCard({ onSubmit });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  card.list([disabledByB]);
  fireEvent.click(within(review()).getByRole("button", { name: "Keep my draft" }));

  expect(screen.queryByRole("region", { name: "A newer version of this connection is saved" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("form"));
  // The draft moves the secret back to the old origin, so it must be typed again.
  expect((screen.getByLabelText("Secret") as HTMLInputElement).required).toBe(true);
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "re-entered" } });
  onSubmit.mockResolvedValueOnce(undefined);
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    description: "Edited by A", upstreamUrl: "https://vendor.example/mcp", audience: "members", upstreamAuthSecret: "re-entered"
  }), { serverId: "vendor", expectedVersion: 5 });
});

it("replaces the draft with the newer saved connection on Use saved values", async () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => { throw conflict(); });
  const card = renderCard({ onSubmit });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  card.list([disabledByB]);
  fireEvent.click(within(review()).getByRole("button", { name: "Use saved values" }));

  expect(description().value).toBe("Vendor search");
  expect(url().value).toBe("https://replacement.example/mcp");
  expect(screen.getByRole("combobox", { name: "Availability" }).textContent).toBe("Off");
  // Nothing is unsaved now, so closing asks no question.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("asks for the review when a background refresh brings a newer version, with no save attempt", () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => undefined);
  const card = renderCard({ onSubmit });
  fireEvent.change(description(), { target: { value: "Typing" } });
  card.list([disabledByB]);
  expect(review()).toBeTruthy();
  expect(description().value).toBe("Typing");
  // The draft stays editable during the review; the comparison uses the current draft.
  fireEvent.change(description(), { target: { value: "Typing more" } });
  fireEvent.change(url(), { target: { value: "https://typed.example/mcp" } });
  expect(within(review()).getByRole("row", { name: /^URL/ }).textContent).toContain("https://typed.example/mcp");
  expect(saveButton().disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("asks for the review for an unchanged draft too, because a save writes every field", () => {
  const card = renderCard();
  card.list([{ ...opened, version: 4, isPublished: false }]);
  expect(within(review()).getByRole("row", { name: /^Availability/ }).textContent).toBe("AvailabilityTest usersAll members");
  expect(saveButton().disabled).toBe(true);
});

it("keeps the draft and offers another read when the list cannot reload after a 409", async () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => { throw conflict(); });
  const onReload = vi.fn<NonNullable<CardProps["onReload"]>>(async () => { throw new Error("offline"); });
  const card = renderCard({ onSubmit, onReload });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());

  const notice = await screen.findByRole("region", { name: "This connection changed after you opened it" });
  expect(within(notice).getByRole("alert").textContent).toBe(
    "Your draft is kept. Load the saved connection to compare it with your draft."
  );
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(within(notice).getByRole("button", { name: "Load saved connection" }));
  await waitFor(() => expect(within(notice).getByText("offline")).toBeTruthy());
  expect(description().value).toBe("Edited by A");
  expect(saveButton().disabled).toBe(true);

  onReload.mockImplementationOnce(async () => { card.list([disabledByB]); });
  fireEvent.click(within(notice).getByRole("button", { name: "Load saved connection" }));
  await waitFor(() => expect(review()).toBeTruthy());
  expect(onReload).toHaveBeenCalledTimes(2);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("reviews each successive conflict against the version the draft last took", async () => {
  const onSubmit = vi.fn<CardProps["onSubmit"]>(async () => { throw conflict(); });
  const card = renderCard({ onSubmit });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  const testUsers = { ...opened, version: 5, isPublished: false };
  card.list([testUsers]);
  fireEvent.click(within(review()).getByRole("button", { name: "Keep my draft" }));

  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  expect(onSubmit).toHaveBeenLastCalledWith(expect.anything(), { serverId: "vendor", expectedVersion: 5 });
  card.list([{ ...testUsers, version: 7, serverName: "Vendor tools (frozen)" }]);
  expect(within(review()).getByRole("alert").textContent).toContain("Version 7 was saved after you opened version 5.");
  // Only the change after version 5 is listed.
  expect(within(review()).getAllByRole("row").slice(1).map((row) => row.querySelector("th")?.textContent)).toEqual(["Name"]);
  fireEvent.click(within(review()).getByRole("button", { name: "Keep my draft" }));
  onSubmit.mockResolvedValueOnce(undefined);
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
  expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ serverName: "Vendor tools", audience: "members" }),
    { serverId: "vendor", expectedVersion: 7 });
});

it("never shows a typed secret in the review", async () => {
  const card = renderCard();
  fireEvent.change(screen.getByLabelText("Secret"), { target: { value: "typed-secret-value" } });
  card.list([{ ...opened, version: 4, upstreamAuthType: "none", upstreamAuthConfigured: false }]);
  const rows = within(review()).getAllByRole("row").map((row) => row.textContent);
  expect(rows).toContain("Upstream authenticationNoneBearer token");
  expect(rows).toContain("SecretNot savedNew secret entered");
  expect(review().textContent).not.toContain("typed-secret-value");
});

it("shows no review while its own save runs, and closes after the save", async () => {
  let finish!: () => void;
  const card = renderCard({
    onSubmit: vi.fn<CardProps["onSubmit"]>(() => new Promise<void>((resolve) => { finish = resolve; }))
  });
  fireEvent.change(description(), { target: { value: "Edited by A" } });
  fireEvent.click(saveButton());
  // The page reloads the list before the save call returns.
  card.list([{ ...opened, version: 5, description: "Edited by A" }]);
  expect(screen.queryByRole("region", { name: "A newer version of this connection is saved" })).toBeNull();
  await act(async () => { finish(); });
  expect(screen.queryByRole("form")).toBeNull();
});
