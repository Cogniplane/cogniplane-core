import type { FastifyRequest, FastifyReply } from "fastify";

export type Role = "owner" | "admin" | "member";

export function requireRole(request: FastifyRequest, reply: FastifyReply, ...roles: Role[]): boolean {
  if (!roles.includes(request.auth.role)) {
    reply.code(403).send({ error: "forbidden", message: "Insufficient permissions" });
    return false;
  }
  return true;
}
