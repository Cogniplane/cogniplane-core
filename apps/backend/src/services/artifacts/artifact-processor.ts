import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { ArtifactStorage } from "./artifact-storage.js";
import type { ArtifactRecord } from "./artifact-store.js";

const execFile = promisify(execFileCallback);

async function readStreamAsBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export class ArtifactProcessor {
  constructor(
    private readonly deps: {
      config: Pick<AppConfig, "PDFTOTEXT_BINARY_PATH">;
      logger: Pick<FastifyBaseLogger, "warn" | "error">;
      storage: Pick<ArtifactStorage, "openReadStream">;
      extractPdfText?: (pdfBuffer: Buffer) => Promise<string>;
    }
  ) {}

  async extractArtifactText(artifact: ArtifactRecord): Promise<string | null> {
    if (
      artifact.mimeType !== "application/pdf" ||
      artifact.status === "deleted" ||
      artifact.status === "failed"
    ) {
      return null;
    }

    const handle = await this.deps.storage.openReadStream(artifact.storageKey);
    const pdfBuffer = await readStreamAsBuffer(handle.stream);
    return this.extractPdfText(pdfBuffer);
  }

  private async extractPdfText(pdfBuffer: Buffer): Promise<string> {
    if (this.deps.extractPdfText) {
      return this.deps.extractPdfText(pdfBuffer);
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cogniplane-pdf-extract-"));
    const inputPath = path.join(tempDir, "input.pdf");

    try {
      await writeFile(inputPath, pdfBuffer);
      const { stdout } = await execFile(this.deps.config.PDFTOTEXT_BINARY_PATH, [
        "-layout",
        "-enc",
        "UTF-8",
        inputPath,
        "-"
      ]);

      return stdout.trim();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
