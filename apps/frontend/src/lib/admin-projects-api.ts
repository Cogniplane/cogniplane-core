import { OwnerlessProjectsResponseSchema } from "@cogniplane/shared-types";
import { request } from "./api-client";
import { parseResponse } from "./validate-response";

// Organization admins only. The backend checks the role, and it lists names
// only. It gives an admin no access to project content.
export async function listOwnerlessProjects() {
  return parseResponse(
    OwnerlessProjectsResponseSchema,
    await request<unknown>("/admin/projects/ownerless"),
    "GET /admin/projects/ownerless"
  ).projects;
}

/** Makes an organization member the owner of a project that has no owner. The
 *  backend writes an audit event. The route answers 204. */
export async function recoverProjectOwner(projectId: string, userId: string): Promise<void> {
  await request<unknown>(`/admin/projects/${encodeURIComponent(projectId)}/recover-owner`, {
    method: "POST",
    body: JSON.stringify({ userId })
  });
}
