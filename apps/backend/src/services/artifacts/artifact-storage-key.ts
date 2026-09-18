import { extname } from "node:path";
import { uuidv7 } from "../../lib/uuid.js";

export function buildArtifactStorageKey(input: {
  userId: string;
  sessionId: string;
  artifactName: string;
}): string {
  const extension = extname(input.artifactName).slice(0, 32);
  const safeExtension = extension.replace(/[^a-zA-Z0-9._-]/g, "");
  return `${input.userId}/${input.sessionId}/${uuidv7()}${safeExtension}`;
}
