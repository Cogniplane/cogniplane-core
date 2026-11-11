import { extname } from "node:path";
import { uuidv7 } from "../../lib/uuid.js";

/**
 * Storage key for a new session artifact object:
 * `<tenantId>/<userId>/<sessionId>/<uuidv7><extension>`.
 *
 * Uploads (`UploadAdmission`) and the `write_artifact` tool both call this, so
 * the layout is the same for all session artifacts. The tenant is first, so all
 * objects of one tenant share one prefix. Rows written before the tenant
 * segment keep `<userId>/<sessionId>/...`. Readers use the key stored on the row
 * and never rebuild it.
 *
 * The extension comes from the last path segment of the name. It keeps at most
 * 32 characters, then only letters, digits, `.`, `_` and `-`.
 */
export function buildArtifactStorageKey(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  artifactName: string;
}): string {
  const extension = extname(input.artifactName).slice(0, 32);
  const safeExtension = extension.replace(/[^a-zA-Z0-9._-]/g, "");
  return `${input.tenantId}/${input.userId}/${input.sessionId}/${uuidv7()}${safeExtension}`;
}
