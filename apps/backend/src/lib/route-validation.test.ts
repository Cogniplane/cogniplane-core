import { describe, test, expect } from "vitest";

import { z } from "zod";

import type { FastifyReply } from "fastify";

import { parseRequestInput } from "./route-validation.js";

function fakeReply() {
  const reply: { _status?: number; code: (n: number) => unknown } = {
    code(n) {
      reply._status = n;
      return reply;
    }
  };
  return reply as unknown as FastifyReply & { _status?: number };
}

describe("parseRequestInput", () => {
  const schema = z.object({ name: z.string().min(2) });

  test("returns ok=true with the parsed value", () => {
    const reply = fakeReply();
    const result = parseRequestInput(reply, schema, { name: "ok" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ name: "ok" });
  });

  test("returns ok=false with a 400 validation envelope on invalid input", () => {
    const reply = fakeReply();
    const result = parseRequestInput(reply, schema, { name: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(reply._status).toBe(400);
    // validationError shape: { error: "invalid_request", details: [...] }
    expect(result.response.error).toBe("invalid_request");
  });
});
