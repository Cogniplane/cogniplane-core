import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { MessageStore } from "../message-store.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import type { PiiScanArtifactInput } from "./pii-provider.js";
import type { PiiScanSubjectReader } from "./pii-scan-job-handler.js";
import { withTenantScope, type Pool } from "../../lib/db.js";

/**
 * Hard cap on bytes buffered from artifact storage during a PII scan read.
 * Matches the `PiiProtectionService` default (`artifactMaxBytes`) so the
 * stream read fails fast — before the whole object lands in memory — instead
 * of OOMing on a multi-GB upload and only then hitting the service-level cap.
 */
const ARTIFACT_READ_MAX_BYTES = 5 * 1024 * 1024;

export class DatabasePiiScanSubjectReader implements PiiScanSubjectReader {
  constructor(
    private readonly deps: {
      db: Pool;
      messages: MessageStore;
      artifacts: ArtifactStore;
      storage: ArtifactStorage;
      /** Overrides the default 5 MiB read cap. */
      maxBytes?: number;
    }
  ) {}

  async readMessageText(input: {
    tenantId: string;
    messageId: string;
  }): Promise<string | null> {
    // `MessageStore.getOwned` requires a userId; the scheduler worker does not
    // carry one, so we read directly under the tenant scope. RLS still applies.
    return withTenantScope(this.deps.db, input.tenantId, async (client) => {
      const result = await client.query<{ content_text: string }>(
        `SELECT content_text FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
        [input.tenantId, input.messageId]
      );
      if (result.rows.length === 0) return null;
      return result.rows[0].content_text ?? "";
    });
  }

  async readArtifact(input: {
    tenantId: string;
    artifactId: string;
  }): Promise<PiiScanArtifactInput | null> {
    const artifact = await this.deps.artifacts.get(input.tenantId, input.artifactId);
    if (!artifact) return null;

    const storage = this.deps.storage;
    const maxBytes = this.deps.maxBytes ?? ARTIFACT_READ_MAX_BYTES;
    // `entityTypes` on the input is part of the provider contract but the
    // protection service resolves the effective list from tenant settings —
    // this array is a placeholder to satisfy the type.
    return {
      artifactId: artifact.artifactId,
      contentType: artifact.mimeType,
      entityTypes: [],
      async readContent() {
        const handle = await storage.openReadStream(artifact.storageKey);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of handle.stream) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          // Enforce the cap while reading so a huge object can't be fully
          // buffered into memory before the service-level check runs.
          if (total > maxBytes) {
            const destroyable = handle.stream as { destroy?: () => void };
            if (typeof destroyable.destroy === "function") {
              destroyable.destroy();
            }
            throw new PiiProtectionServiceError(
              "file_too_large",
              `Artifact exceeds the ${maxBytes}-byte PII scan cap`
            );
          }
          chunks.push(buf);
        }
        return Buffer.concat(chunks).toString("utf8");
      }
    };
  }
}
