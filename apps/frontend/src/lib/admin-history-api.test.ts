import { afterEach, expect, test, vi } from "vitest";
import type { AdminHistoryEvent } from "@cogniplane/shared-types";
import { getAdminHistoryEvent, listAdminHistory } from "./admin-history-api";
import { request } from "./api-client";

vi.mock("./api-client", () => ({ request: vi.fn() }));
const privacy: AdminHistoryEvent = {
  eventId: "9007199254740993", type: "tenant.pii_protection.updated", category: "policies",
  title: "Privacy protection changed", createdAt: "2026-11-04T14:30:00.000001Z",
  actor: { userId: null, name: "Actor no longer available" }, details: [], settingsVersion: null,
  target: { label: "Open policies", href: "/admin/policy" }
};
afterEach(() => vi.resetAllMocks());

test("normalizes the known privacy destination in lists and details after schema validation", async () => {
  vi.mocked(request).mockResolvedValueOnce({ items: [privacy], nextCursor: "opaque-cursor" })
    .mockResolvedValueOnce({ event: privacy, comparison: null });
  const signal = new AbortController().signal;
  const list = await listAdminHistory({ category: "policies", cursor: "scope-bound", limit: 25 }, signal);
  const detail = await getAdminHistoryEvent(privacy.eventId, undefined, signal);
  expect(list).toEqual({ items: [{ ...privacy, target: { label: "Open privacy", href: "/admin/privacy" } }], nextCursor: "opaque-cursor" });
  expect(detail.event).toEqual(list.items[0]);
  expect(request).toHaveBeenCalledWith(`/admin/history/${privacy.eventId}`, { signal });
  expect(request).toHaveBeenCalledWith("/admin/history?category=policies&cursor=scope-bound&limit=25", { signal });
  expect(privacy.target?.href).toBe("/admin/policy");
});

test.each([
  { ...privacy, type: "admin.policy_rule.updated" },
  { ...privacy, target: null },
  { ...privacy, target: { label: "Open privacy settings", href: "/admin/privacy" } },
  { ...privacy, target: { label: "Other reviewed target", href: "/admin/connections" } }
])("preserves other event destinations and the rest of the projection", async event => {
  vi.mocked(request).mockResolvedValue({ event, comparison: null });
  expect((await getAdminHistoryEvent(event.eventId)).event).toEqual(event);
});

test("rejects a target outside the admin contract before normalization", async () => {
  vi.mocked(request).mockResolvedValue({ event: { ...privacy, target: { label: "Unsafe", href: "https://fictional.example" } }, comparison: null });
  await expect(getAdminHistoryEvent(privacy.eventId)).rejects.toThrow();
});
