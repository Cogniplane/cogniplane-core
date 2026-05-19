import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { MessageStore } from "../message-store.js";
import type { PiiScanArtifactInput } from "./pii-provider.js";
import type { PiiScanSubjectReader } from "./pii-scan-job-handler.js";
import { withTenantScope, type Pool } from "../../lib/db.js";

export class DatabasePiiScanSubjectReader implements PiiScanSubjectReader {
  constructor(
    private readonly deps: {
      db: Pool;
      messages: MessageStore;
      artifacts: ArtifactStore;
      storage: ArtifactStorage;
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
        for await (const chunk of handle.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf8");
      }
    };
  }
}
