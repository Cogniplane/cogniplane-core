import { beforeEach, expect, it, vi } from "vitest";
import { listArchivedSessions, listSessions } from "./session-api";
import { request } from "./api-client";

vi.mock("./api-client", () => ({ request: vi.fn() }));
beforeEach(() => { vi.mocked(request).mockReset().mockResolvedValue({ sessions: [] }); });

it("requests the same normal and skill-improvement scope for active and archived chat lists", async () => {
  await listSessions();
  await listArchivedSessions();
  const urls = vi.mocked(request).mock.calls.map(([path]) => new URL(path, "http://localhost"));
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    expect(url.pathname).toBe("/sessions");
    expect(url.searchParams.get("purposes")).toBe("normal,skill_improvement");
  }
  expect(urls[0].searchParams.get("status")).toBeNull();
  expect(urls[1].searchParams.get("status")).toBe("archived");
});

it("returns the server's effective Trash retention window", async () => {
  vi.mocked(request).mockResolvedValue({ sessions: [], trashRetentionDays: 7 });

  expect((await listArchivedSessions()).trashRetentionDays).toBe(7);
});
