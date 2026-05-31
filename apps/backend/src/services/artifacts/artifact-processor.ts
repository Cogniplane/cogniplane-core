import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../../config.js";
import type { ArtifactStorage } from "./artifact-storage.js";

const NO_OP_CLEANUP = async () => {};
import type { ArtifactRecord } from "./artifact-store.js";

const execFile = promisify(execFileCallback);

/**
 * Narrow shape of the promisified `execFile` used for PDF rasterization.
 * Injectable so tests can drive the pdftoppm-failure path deterministically
 * without depending on host poppler-utils (mirrors the `extractPdfText` seam).
 */
export type ExecFile = (
  file: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

async function readStreamAsBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export type PreparedArtifactImages = {
  paths: string[];
  cleanup: () => Promise<void>;
};

export class ArtifactProcessor {
  constructor(
    private readonly deps: {
      config: Pick<AppConfig, "PDFTOTEXT_BINARY_PATH">;
      logger: Pick<FastifyBaseLogger, "warn" | "error">;
      storage: ArtifactStorage;
      extractPdfText?: (pdfBuffer: Buffer) => Promise<string>;
      execFile?: ExecFile;
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

  async renderArtifactImages(
    artifact: ArtifactRecord,
    maxPages = 8
  ): Promise<PreparedArtifactImages> {
    if (
      artifact.mimeType !== "application/pdf" ||
      artifact.status === "deleted" ||
      artifact.status === "failed"
    ) {
      return {
        paths: [],
        cleanup: NO_OP_CLEANUP
      };
    }

    const handle = await this.deps.storage.openReadStream(artifact.storageKey);
    const pdfBuffer = await readStreamAsBuffer(handle.stream);
    try {
      return await this.renderPdfImages(pdfBuffer, maxPages);
    } catch (error) {
      this.deps.logger.warn(
        {
          artifactId: artifact.artifactId,
          error: error instanceof Error ? error.message : String(error)
        },
        "Failed to render PDF artifact pages as images"
      );
      return {
        paths: [],
        cleanup: NO_OP_CLEANUP
      };
    }
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

  private async renderPdfImages(
    pdfBuffer: Buffer,
    maxPages: number
  ): Promise<PreparedArtifactImages> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cogniplane-pdf-pages-"));
    const inputPath = path.join(tempDir, "input.pdf");
    const outputPrefix = path.join(tempDir, "page");

    const runExecFile = this.deps.execFile ?? execFile;

    try {
      await writeFile(inputPath, pdfBuffer);
      await runExecFile("pdftoppm", [
        "-png",
        "-r",
        "144",
        "-f",
        "1",
        "-l",
        String(maxPages),
        inputPath,
        outputPrefix
      ]);

      const files = await readdir(tempDir);
      const paths = files
        .filter((file) => file.startsWith("page-") && file.endsWith(".png"))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map((file) => path.join(tempDir, file));

      return {
        paths,
        cleanup: async () => {
          await rm(tempDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }
}
