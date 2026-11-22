import type { ArtifactRecord } from "./artifact-store.js";

/**
 * The public response for an artifact.
 *
 * It names each field, so a field added to the stored record does not reach
 * clients until it is added here. The fields are those that the routes sent
 * when they returned the record itself, the row `id` included. Change a
 * public field here, not in the record.
 */
export type ArtifactResponse = Pick<
  ArtifactRecord,
  | "id"
  | "artifactId"
  | "sessionId"
  | "userId"
  | "artifactType"
  | "sourceArtifactId"
  | "artifactName"
  | "mimeType"
  | "storageBackend"
  | "storageKey"
  | "fileSizeBytes"
  | "checksumSha256"
  | "status"
  | "createdByType"
  | "createdByRef"
  | "detail"
  | "createdAt"
  | "updatedAt"
>;

export function toArtifactResponse(artifact: ArtifactRecord): ArtifactResponse {
  return {
    id: artifact.id,
    artifactId: artifact.artifactId,
    sessionId: artifact.sessionId,
    userId: artifact.userId,
    artifactType: artifact.artifactType,
    sourceArtifactId: artifact.sourceArtifactId,
    artifactName: artifact.artifactName,
    mimeType: artifact.mimeType,
    storageBackend: artifact.storageBackend,
    storageKey: artifact.storageKey,
    fileSizeBytes: artifact.fileSizeBytes,
    checksumSha256: artifact.checksumSha256,
    status: artifact.status,
    createdByType: artifact.createdByType,
    createdByRef: artifact.createdByRef,
    detail: artifact.detail,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt
  };
}
