import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { deleteMemory, listMemories, updateMemory } from "./memories-api";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api-client", () => ({ request }));

const scope = { tenantId: "tenant-a", userId: "member-1" };
const memory = {
  id: "m1", name: "units", content: "Metric.", metadata: {}, version: 2, provenance: "agent_approved",
  approvedAt: "2026-07-02T10:00:00.000Z", createdAt: "2026-07-01T10:00:00.000Z", updatedAt: "2026-07-02T10:00:00.000Z"
};

beforeEach(() => { request.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

it("reads the list from /me/memories and validates the contract", async () => {
  request.mockResolvedValue({ scope, memories: [memory], total: 1 });

  expect(await listMemories()).toEqual({ scope, memories: [memory], total: 1 });
  expect(request).toHaveBeenCalledWith("/me/memories");
});

it("refuses a list in a shape that the contract does not allow", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  request.mockResolvedValue({ scope, memories: [{ ...memory, provenance: "approved_by_the_model" }], total: 1 });

  await expect(listMemories()).rejects.toThrow(/Schema mismatch at GET \/me\/memories/);
});

it("sends an edit by id with the account and the version", async () => {
  request.mockResolvedValue({ scope, memory: { ...memory, content: "Edited.", version: 3 } });

  const result = await updateMemory("m 1/2", { scope, content: "Edited.", version: 2 });

  expect(result.memory.version).toBe(3);
  expect(request).toHaveBeenCalledWith("/me/memories/m%201%2F2", {
    method: "PUT", body: JSON.stringify({ scope, content: "Edited.", version: 2 })
  });
});

it("sends a delete by id with the account", async () => {
  request.mockResolvedValue(undefined);

  await deleteMemory("m1", scope);

  expect(request).toHaveBeenCalledWith("/me/memories/m1", { method: "DELETE", body: JSON.stringify({ scope }) });
});
