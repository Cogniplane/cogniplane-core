import {
  MemoriesResponseSchema,
  MemoryResponseSchema,
  type MemoryScope,
  type MemoryUpdateRequest
} from "@cogniplane/shared-types";

import { requestJson, requestEmpty } from "./api-client";

const path = "/me/memories";
// A memory is addressed by its id. Its name can be longer than a URL segment may be.
const itemPath = (memoryId: string) => `${path}/${encodeURIComponent(memoryId)}`;

/** The signed-in user's saved memories, most recently updated first. */
export async function listMemories() {
  return await requestJson(path, MemoriesResponseSchema);
}

/** Replaces the text of one memory. `scope` and `version` are what the page loaded. */
export async function updateMemory(memoryId: string, input: MemoryUpdateRequest) {
  const url = itemPath(memoryId);
  return await requestJson(url, MemoryResponseSchema, { method: "PUT", body: JSON.stringify(input) });
}

export async function deleteMemory(memoryId: string, scope: MemoryScope): Promise<void> {
  await requestEmpty(itemPath(memoryId), { method: "DELETE", body: JSON.stringify({ scope }) });
}
