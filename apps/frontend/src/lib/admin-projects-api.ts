import { OwnerlessProjectsResponseSchema } from "@cogniplane/shared-types";
import { requestJson, requestEmpty } from "./api-client";

// Organization admins only. The backend checks the role, and it lists names
// only. It gives an admin no access to project content.
export async function listOwnerlessProjects() {
  return (await requestJson("/admin/projects/ownerless", OwnerlessProjectsResponseSchema)).projects;
}

/** Makes an organization member the owner of a project that has no owner. The
 *  backend writes an audit event. The route answers 204. */
export async function recoverProjectOwner(projectId: string, userId: string): Promise<void> {
  await requestEmpty(`/admin/projects/${encodeURIComponent(projectId)}/recover-owner`, {
    method: "POST",
    body: JSON.stringify({ userId })
  });
}
