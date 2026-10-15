import {
  MemoriesResponseSchema,
  MemoryResponseSchema,
  type MemoryScope,
  type MemoryUpdateRequest
} from "@cogniplane/shared-types";

import { request } from "./api-client";
import { parseResponse } from "./validate-response";

const path = "/me/memories";
// A memory is addressed by its id. Its name can be longer than a URL segment may be.
const itemPath = (memoryId: string) => `${path}/${encodeURIComponent(memoryId)}`;

/** The signed-in user's saved memories, most recently updated first. */
export async function listMemories() {
  return parseResponse(MemoriesResponseSchema, await request<unknown>(path), `GET ${path}`);
}

/** Replaces the text of one memory. `scope` and `version` are what the page loaded. */
export async function updateMemory(memoryId: string, input: MemoryUpdateRequest) {
  const url = itemPath(memoryId);
  return parseResponse(
    MemoryResponseSchema,
    await request<unknown>(url, { method: "PUT", body: JSON.stringify(input) }),
    "PUT /me/memories/:id"
  );
}

export async function deleteMemory(memoryId: string, scope: MemoryScope): Promise<void> {
  await request<void>(itemPath(memoryId), { method: "DELETE", body: JSON.stringify({ scope }) });
}
