import { expect, it, vi } from "vitest";
import { listMessages } from "./message-api";
import { request } from "./api-client";

vi.mock("./api-client", () => ({ request: vi.fn(async () => ({ messages: [], hasMore: false })) }));

it("sends a message anchor on tail reads", async () => {
  const signal = new AbortController().signal;
  await listMessages("session-id", signal, { since: "anchor-id" });
  const [path, options] = vi.mocked(request).mock.calls.at(-1)!;
  expect(new URL(path, "http://localhost").searchParams.get("since")).toBe("anchor-id");
  expect(options?.signal).toBe(signal);
});
