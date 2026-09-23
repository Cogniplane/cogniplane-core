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

it("encodes cursor, literal search and saved IDs and preserves the next cursor", async () => {
  vi.mocked(request).mockResolvedValue({ sessions: [], nextCursor: "next", trashRetentionDays: 14 });
  const signal = new AbortController().signal;
  expect(await listSessions({ cursor: "opaque+/=", search: "100%_ notes & plans", ids: ["old", "pin"], signal }))
    .toEqual({ sessions: [], nextCursor: "next", trashRetentionDays: 14 });
  const [path, options] = vi.mocked(request).mock.calls[0];
  const params = new URL(path, "http://localhost").searchParams;
  expect(params.get("cursor")).toBe("opaque+/=");
  expect(params.get("search")).toBe("100%_ notes & plans");
  expect(params.get("ids")).toBe("old,pin");
  expect(params.get("limit")).toBe("100");
  expect(options?.signal).toBe(signal);
  await listSessions({ personalOnly: true });
  const pickerParams = new URL(vi.mocked(request).mock.calls[1][0], "http://localhost").searchParams;
  expect(pickerParams.get("purposes")).toBe("normal");
  expect(pickerParams.get("personalOnly")).toBe("true");
});
