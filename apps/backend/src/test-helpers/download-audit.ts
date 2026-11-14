import type { ArtifactDownloadTokenRecord } from "../services/artifacts/artifact-store.js";
import type { AuditEventInput } from "../services/audit-event-store.js";

/** The `artifact_downloaded` event that a test's download consume writes in its transaction. */
export function downloadAudit(token: ArtifactDownloadTokenRecord): AuditEventInput {
  return {
    tenantId: token.tenantId,
    sessionId: token.sessionId,
    userId: token.issuedByUserId ?? token.userId,
    type: "artifact_downloaded",
    payload: { artifactId: token.artifactId }
  };
}
