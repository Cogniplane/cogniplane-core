import { beforeEach, expect, it, vi } from "vitest";

import { browseArtifacts } from "./artifact-api";
import { request } from "./api-client";

// A separate file, because mocking request here would also replace it for
// the fetch-based tests in artifact-api.test.ts.
vi.mock("./api-client", () => ({ request: vi.fn() }));
beforeEach(() => { vi.mocked(request).mockReset().mockResolvedValue({ items: [], nextCursor: null }); });

const requested = () => new URL(vi.mocked(request).mock.calls[0]![0], "http://localhost");

it("sends no query string when nothing is filtered", async () => {
  await browseArtifacts({});

  expect(vi.mocked(request).mock.calls[0]![0]).toBe("/artifacts");
});

it("repeats a multi-value filter once per value and keeps a zero limit", async () => {
  await browseArtifacts({
    q: "q3 report", sort: "name_asc", limit: 0, cursor: "c+/=",
    type: ["document", "spreadsheet"], status: ["ready"], mimeClass: []
  });

  const url = requested();
  expect(url.pathname).toBe("/artifacts");
  expect(url.searchParams.get("q")).toBe("q3 report");
  expect(url.searchParams.get("sort")).toBe("name_asc");
  expect(url.searchParams.get("limit")).toBe("0");
  expect(url.searchParams.get("cursor")).toBe("c+/=");
  expect(url.searchParams.getAll("type")).toEqual(["document", "spreadsheet"]);
  expect(url.searchParams.getAll("status")).toEqual(["ready"]);
  expect(url.searchParams.has("mimeClass")).toBe(false);
});

it("leaves out empty text filters", async () => {
  await browseArtifacts({ q: "", cursor: "" });

  expect(vi.mocked(request).mock.calls[0]![0]).toBe("/artifacts");
});

it("rejects a response that does not match the browse schema", async () => {
  vi.mocked(request).mockResolvedValue({ items: "not a list" });

  await expect(browseArtifacts({})).rejects.toThrow();
});
