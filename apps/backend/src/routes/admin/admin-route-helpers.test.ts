import { describe, test, expect } from "vitest";


import type { FastifyReply } from "fastify";

import { AdminConfigError } from "../../services/admin-config-error.js";

import {
  adminIdSchema,
  configError,
  createAdminAuditEvent,
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

  test("surfaces AdminConfigError messages as 400 invalid_config", () => {
    const reply = fakeReply();
    const body = respondAdminMutationError(
      reply,
      new AdminConfigError("At least one runtime provider must be enabled."),
      "Failed."
    );
    expect(reply._status).toBe(400);
    expect(body).toEqual({
      error: "invalid_config",
      message: "At least one runtime provider must be enabled."
    });
  });

  test("rethrows unexpected errors so the global handler returns an opaque 500", () => {
    const reply = fakeReply();
    const internal = new Error('relation "tenant_settings" does not exist');
    expect(() => respondAdminMutationError(reply, internal, "Failed.")).toThrow(internal);
    expect(() => respondAdminMutationError(reply, "scalar", "Failed.")).toThrow("scalar");
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
