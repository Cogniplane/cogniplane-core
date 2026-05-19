import type { FastifyRequest, FastifyReply } from "fastify";

export type Role = "owner" | "admin" | "member";

export function requireRole(request: FastifyRequest, reply: FastifyReply, ...roles: Role[]): boolean {
  if (!roles.includes(request.auth.role)) {
    reply.code(403).send({ error: "forbidden", message: "Insufficient permissions" });
    return false;
  }
  return true;
}

export function isElevatedRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function canManageTenant(role: Role): boolean {
  return role === "owner";
}

export function canManageMembers(role: Role): boolean {
  return isElevatedRole(role);
}

export function canAccessAdmin(role: Role): boolean {
  return isElevatedRole(role);
}
