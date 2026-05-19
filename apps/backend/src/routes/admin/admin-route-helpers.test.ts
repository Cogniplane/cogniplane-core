import { describe, test, expect } from "vitest";

import { z } from "zod";

import type { FastifyReply } from "fastify";

import {
  adminIdSchema,
  configError,
  createAdminAuditEvent,
  parseAdminCrudBody,
  parseAdminCrudUpdateBody,
  parseAdminInput,
  respondAdminMutationError,
  respondAdminNotFound
} from "./admin-route-helpers.js";

function fakeReply() {
  const reply: { _status?: number; _payload?: unknown; code: (n: number) => unknown; send: (b: unknown) => unknown } = {
    code(n) {
      reply._status = n;
      return reply;
    },
    send(b) {
      reply._payload = b;
      return reply;
    }
  };
  return reply as unknown as FastifyReply & { _status?: number; _payload?: unknown };
}

describe("adminIdSchema", () => {
  test.each([
    "github",
    "github-mcp",
    "x_y",
    "abc123",
    "a"
  ])("accepts '%s'", (id) => {
    expect(() => adminIdSchema.parse(id)).not.toThrow();
  });

  test.each([
    "",
    " ",
    "-leading-dash",
    "_leading-underscore",
    "Has-Uppercase",
    "with space",
    "a".repeat(81)
  ])("rejects '%s'", (id) => {
    expect(() => adminIdSchema.parse(id)).toThrow();
  });
});

describe("configError", () => {
  test("returns invalid_config error code with the supplied message", () => {
    expect(configError("oops")).toEqual({ error: "invalid_config", message: "oops" });
  });
});

describe("respondAdminMutationError", () => {
  test("maps PostgreSQL 23505 to 409 conflict including the constraint name", () => {
    const reply = fakeReply();
    const err = { code: "23505", constraint: "uniq_skill_id" };
    const body = respondAdminMutationError(reply, err, "Already exists.");
    expect(reply._status).toBe(409);
    expect(body).toEqual({
      error: "conflict",
      message: "Already exists. (uniq_skill_id)."
    });
  });

  test("maps 23505 without constraint to 409 with fallback only", () => {
    const reply = fakeReply();
    const body = respondAdminMutationError(reply, { code: "23505" }, "Already exists.");
    expect(reply._status).toBe(409);
    expect(body).toEqual({ error: "conflict", message: "Already exists." });
  });

  test("falls back to 400 invalid_config for non-unique-violation errors", () => {
    const reply = fakeReply();
    const body = respondAdminMutationError(reply, new Error("bad"), "Failed.");
    expect(reply._status).toBe(400);
    expect(body).toEqual({ error: "invalid_config", message: "bad" });
  });

  test("uses the fallback message when the error is not an Error instance", () => {
    const reply = fakeReply();
    const body = respondAdminMutationError(reply, "scalar", "Failed.");
    expect(reply._status).toBe(400);
    expect(body).toEqual({ error: "invalid_config", message: "Failed." });
  });
});

describe("parseAdminInput", () => {
  const schema = z.object({ name: z.string().min(2) });

  test("returns ok=true with the parsed value", () => {
    const reply = fakeReply();
    const result = parseAdminInput(reply, schema, { name: "ok" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ name: "ok" });
  });

  test("returns ok=false with a 400 validation envelope on invalid input", () => {
    const reply = fakeReply();
    const result = parseAdminInput(reply, schema, { name: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(reply._status).toBe(400);
    // validationError shape: { error: "invalid_request", details: [...] }
    expect(result.response.error).toBe("invalid_request");
  });
});

describe("parseAdminCrudBody", () => {
  const schema = z.object({ skillId: z.string().optional(), name: z.string() });

  test("requires the id field to be set", () => {
    const reply = fakeReply();
    const result = parseAdminCrudBody(reply, schema, { name: "x" }, "skillId");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(reply._status).toBe(400);
    expect(result.response.message).toMatch(/skillId is required/);
  });

  test("accepts the body when id field is present", () => {
    const reply = fakeReply();
    const result = parseAdminCrudBody(reply, schema, { skillId: "x", name: "y" }, "skillId");
    expect(result.ok).toBe(true);
  });
});

describe("parseAdminCrudUpdateBody", () => {
  const schema = z.object({ skillId: z.string().optional(), name: z.string() });

  test("rejects when body id mismatches route id", () => {
    const reply = fakeReply();
    const result = parseAdminCrudUpdateBody(
      reply,
      schema,
      { skillId: "wrong", name: "y" },
      "skillId",
      "right"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(reply._status).toBe(400);
    expect(result.response.message).toMatch(/skillId must match the route parameter/);
  });

  test("accepts when body id matches the route id", () => {
    const reply = fakeReply();
    const result = parseAdminCrudUpdateBody(
      reply,
      schema,
      { skillId: "right", name: "y" },
      "skillId",
      "right"
    );
    expect(result.ok).toBe(true);
  });

  test("accepts when body id is omitted (route id is canonical)", () => {
    const reply = fakeReply();
    const result = parseAdminCrudUpdateBody(
      reply,
      schema,
      { name: "y" },
      "skillId",
      "right"
    );
    expect(result.ok).toBe(true);
  });
});

describe("respondAdminNotFound", () => {
  test("sets 404 and returns not-found envelope", () => {
    const reply = fakeReply();
    const body = respondAdminNotFound(reply, "skill_not_found");
    expect(reply._status).toBe(404);
    expect(body.error).toBe("skill_not_found");
  });
});

describe("createAdminAuditEvent", () => {
  test("forwards to the underlying audit-event store with sessionId=null", async () => {
    const events: Array<Record<string, unknown>> = [];
    const auditEvents = {
      async create(input: Record<string, unknown>) {
        events.push(input);
      }
    };
    await createAdminAuditEvent(auditEvents as never, {
      tenantId: "t",
      userId: "u",
      type: "admin.skill.activate",
      payload: { skillId: "x" },
      ipAddress: "127.0.0.1",
      userAgent: "test"
    });
    expect(events).toEqual([
      {
        tenantId: "t",
        sessionId: null,
        userId: "u",
        type: "admin.skill.activate",
        payload: { skillId: "x" },
        ipAddress: "127.0.0.1",
        userAgent: "test"
      }
    ]);
  });

  test("works without ip/userAgent", async () => {
    const events: Array<Record<string, unknown>> = [];
    const auditEvents = {
      async create(input: Record<string, unknown>) {
        events.push(input);
      }
    };
    await createAdminAuditEvent(auditEvents as never, {
      tenantId: "t",
      userId: "u",
      type: "admin.skill.activate",
      payload: {}
    });
    expect(events[0]?.ipAddress).toBeUndefined();
    expect(events[0]?.userAgent).toBeUndefined();
    expect(events[0]?.sessionId).toBeNull();
  });
});
