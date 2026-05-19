import { test, expect, describe } from "vitest";

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  canAccessAdmin,
  canManageMembers,
  canManageTenant,
  isElevatedRole,
  requireRole,
  type Role
} from "./rbac.js";

const ROLES: Role[] = ["owner", "admin", "member"];

describe("isElevatedRole", () => {
  test("owner and admin are elevated; member is not", () => {
    expect(isElevatedRole("owner")).toBe(true);
    expect(isElevatedRole("admin")).toBe(true);
    expect(isElevatedRole("member")).toBe(false);
  });
});

describe("canManageTenant", () => {
  test("owner can manage; admin and member cannot", () => {
    expect(canManageTenant("owner")).toBe(true);
    expect(canManageTenant("admin")).toBe(false);
    expect(canManageTenant("member")).toBe(false);
  });
});

describe("canManageMembers", () => {
  test("owner and admin can manage members; member cannot", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("member")).toBe(false);
  });
});

describe("canAccessAdmin", () => {
  test("owner and admin can access admin; member cannot", () => {
    expect(canAccessAdmin("owner")).toBe(true);
    expect(canAccessAdmin("admin")).toBe(true);
    expect(canAccessAdmin("member")).toBe(false);
  });
});

describe("requireRole", () => {
  function fakeReply(): FastifyReply & { _status?: number; _payload?: unknown } {
    const reply: { _status?: number; _payload?: unknown; code: (n: number) => unknown; send: (b: unknown) => unknown } = {
      code(n: number) {
        reply._status = n;
        return reply;
      },
      send(payload: unknown) {
        reply._payload = payload;
        return reply;
      }
    };
    return reply as unknown as FastifyReply & { _status?: number; _payload?: unknown };
  }

  function fakeRequest(role: Role): FastifyRequest {
    return { auth: { role } } as unknown as FastifyRequest;
  }

  test.each([
    ["owner", ["owner", "admin"], true],
    ["admin", ["owner", "admin"], true],
    ["member", ["owner", "admin"], false],
    ["member", ["member"], true]
  ] as Array<[Role, Role[], boolean]>)(
    "role=%s allowed=%j -> %s",
    (role, allowed, expected) => {
      const reply = fakeReply();
      const ok = requireRole(fakeRequest(role), reply, ...allowed);
      expect(ok).toBe(expected);
      if (!expected) {
        expect(reply._status).toBe(403);
        expect(reply._payload).toEqual({
          error: "forbidden",
          message: "Insufficient permissions"
        });
      }
    }
  );

  test("does not touch reply when role is allowed", () => {
    const reply = fakeReply();
    requireRole(fakeRequest("owner"), reply, "owner");
    expect(reply._status).toBeUndefined();
    expect(reply._payload).toBeUndefined();
  });

  test("rejects when no roles are allowed (empty allowlist always denies)", () => {
    for (const role of ROLES) {
      const reply = fakeReply();
      expect(requireRole(fakeRequest(role), reply)).toBe(false);
      expect(reply._status).toBe(403);
    }
  });
});
