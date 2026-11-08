import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * How much of a PDF's rendered pages the OCR pass read.
 * - `complete`: every page was rendered and recognized.
 * - `partial`: the pass stopped at a limit after one or more pages.
 * - `failed`: a tool failed, or no page was read.
 * `complete` means that every page was processed, not that OCR recognized
 * every value on it.
 */
export type PdfOcrStatus = "complete" | "partial" | "failed";

/** Why a pass is not complete. Internal: logs and error mapping only. */
export type PdfOcrIncompleteReason = "page_limit" | "text_limit" | "budget" | "busy" | "error";

export interface PdfOcrResult {
  text: string;
  status: PdfOcrStatus;
  pagesScanned: number;
  /** Absent when the page count could not be read. */
  pageCount?: number;
  reason?: PdfOcrIncompleteReason;
}

export type PdfOcr = (pdf: Buffer, signal?: AbortSignal) => Promise<PdfOcrResult>;

/**
 * Runs a binary with a fixed argv. Resolves with stdout only after the child
 * exits. Never returns stderr: tool diagnostics can quote document content.
 */
export type RunBinary = (
  file: string,
  args: string[],
  options: { signal: AbortSignal; maxOutputBytes: number; env?: NodeJS.ProcessEnv }
) => Promise<string>;

export interface PdfOcrOptions {
  pdfinfoPath: string;
  pdftoppmPath: string;
  tesseractPath: string;
  /** Tesseract language list, for example `eng` or `eng+fra`. */
  languages: string;
  maxPages: number;
  /** Wall-clock budget for one PDF, including the wait for a slot. */
  timeoutMs: number;
  maxConcurrent: number;
  /** The pass stops (partial) when its text reaches this size. */
  maxTextBytes: number;
  logger?: { warn(payload: unknown, message: string): void };
  runBinary?: RunBinary;
}

// Rendering limits. 300 DPI is the resolution that Tesseract recommends;
// the longest side is capped so a large page cannot make a huge raster.
const RENDER_DPI = "300";
const RENDER_MAX_SIDE_PX = "3508";
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_QUEUED_PER_SLOT = 8;

/**
 * Tesseract often reads an email address in a proportional font with a space
 * after the `@` ("jane@ example.com"), so the email rule would miss it. Spaces
 * and tabs next to an `@` between two other characters are removed.
 */
export function normalizeOcrText(text: string): string {
  return text.replace(/(\S)[ \t]*@[ \t]*(?=\S)/g, "$1@").trim();
}

export function isPdfContentType(contentType: string): boolean {
  return (contentType.toLowerCase().split(";")[0]?.trim() ?? "") === "application/pdf";
}

class OcrError extends Error {
  constructor(readonly reason: PdfOcrIncompleteReason, readonly step: string) {
    super(`PDF OCR ${step} failed`);
  }
}

/**
 * Local OCR for the PII scan of a PDF: `pdfinfo` reads the page count,
 * `pdftoppm` renders one page at a time, and `tesseract` reads it. Nothing
 * leaves the host. Page images live in a private temporary directory that is
 * removed before the call returns. The text is returned, never logged.
 */
export function createPdfOcr(options: PdfOcrOptions): PdfOcr & { verify(): Promise<void> } {
  const run = options.runBinary ?? runBoundedBinary;
  const slots = new OcrSlots(options.maxConcurrent, options.maxConcurrent * MAX_QUEUED_PER_SLOT);

  const ocrPdf = async (pdf: Buffer, signal?: AbortSignal): Promise<PdfOcrResult> => {
    const startedAt = Date.now();
    const budget = AbortSignal.timeout(options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, budget]) : budget;
    const result: PdfOcrResult = { text: "", status: "failed", pagesScanned: 0 };
    let failure: OcrError | undefined;

    try {
      await slots.acquire(combined);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      failure = error instanceof OcrError ? error : new OcrError("budget", "slot");
      return finish(result, failure, startedAt);
    }

    let dir: string | undefined;
    const pages: string[] = [];
    let textBytes = 0;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), "cogniplane-pdf-ocr-"));
      const inputPath = path.join(dir, "input.pdf");
      await writeFile(inputPath, pdf, { mode: 0o600 });

      const info = await step("pdfinfo", () =>
        run(options.pdfinfoPath, [inputPath], { signal: combined, maxOutputBytes: MAX_TOOL_OUTPUT_BYTES })
      );
      const pageCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1] ?? Number.NaN);
      if (!Number.isInteger(pageCount) || pageCount < 1) throw new OcrError("error", "pdfinfo");
      result.pageCount = pageCount;

      const lastPage = Math.min(pageCount, options.maxPages);
      const pageRoot = path.join(dir, "page");
      const pageImage = `${pageRoot}.png`;
      for (let page = 1; page <= lastPage; page += 1) {
        await step("pdftoppm", () =>
          run(
            options.pdftoppmPath,
            ["-f", String(page), "-l", String(page), "-r", RENDER_DPI, "-scale-to", RENDER_MAX_SIDE_PX,
              "-gray", "-png", "-singlefile", inputPath, pageRoot],
            { signal: combined, maxOutputBytes: MAX_TOOL_OUTPUT_BYTES }
          )
        );
        const text = await step("tesseract", () =>
          run(options.tesseractPath, [pageImage, "stdout", "-l", options.languages, "--psm", "3"], {
            signal: combined,
            maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
            // One thread per process: the slot count bounds CPU use.
            env: { ...toolEnv(), OMP_THREAD_LIMIT: "1" }
          })
        );
        await rm(pageImage, { force: true });
        pages.push(normalizeOcrText(text));
        result.pagesScanned = page;
        textBytes += Buffer.byteLength(text, "utf8");
        if (textBytes >= options.maxTextBytes && page < pageCount) {
          throw new OcrError("text_limit", "text");
        }
      }
      if (lastPage < pageCount) throw new OcrError("page_limit", "pages");
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      failure = error instanceof OcrError ? error : new OcrError("error", "setup");
      if (budget.aborted) failure = new OcrError("budget", failure.step);
    } finally {
      // The runner resolves only after the child exits, so no tool still
      // writes in the directory, and the slot is free for the next PDF.
      if (dir) await rm(dir, { recursive: true, force: true });
      slots.release();
    }

    result.text = pages.filter((text) => text !== "").join("\n\n");
    return finish(result, failure, startedAt);

    async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
      try {
        return await action();
      } catch {
        // The tool error can hold document text: keep only the step name.
        throw new OcrError("error", name);
      }
    }
  };

  const finish = (result: PdfOcrResult, failure: OcrError | undefined, startedAt: number): PdfOcrResult => {
    if (!failure) {
      result.status = result.pagesScanned > 0 ? "complete" : "failed";
      return result;
    }
    const stoppedAtLimit = failure.reason === "page_limit" || failure.reason === "text_limit" || failure.reason === "budget";
    result.status = stoppedAtLimit && result.pagesScanned > 0 ? "partial" : "failed";
    result.reason = failure.reason;
    options.logger?.warn(
      {
        reason: failure.reason,
        step: failure.step,
        pagesScanned: result.pagesScanned,
        pageCount: result.pageCount,
        durationMs: Date.now() - startedAt
      },
      "PDF OCR for the PII scan did not complete"
    );
    return result;
  };

  return Object.assign(ocrPdf, {
    /** Checks that the tools run and that each configured language is installed. */
    async verify(): Promise<void> {
      const signal = AbortSignal.timeout(10_000);
      const limits = { signal, maxOutputBytes: MAX_TOOL_OUTPUT_BYTES };
      for (const [name, file] of [["pdfinfo", options.pdfinfoPath], ["pdftoppm", options.pdftoppmPath]] as const) {
        try {
          await run(file, ["-v"], limits);
        } catch {
          throw new Error(`PII_PDF_OCR_ENABLED=true, but ${name} (${file}) does not run.`);
        }
      }
      let listed: string;
      try {
        listed = await run(options.tesseractPath, ["--list-langs"], limits);
      } catch {
        throw new Error(`PII_PDF_OCR_ENABLED=true, but tesseract (${options.tesseractPath}) does not run.`);
      }
      const installed = new Set(listed.split(/\r?\n/).map((line) => line.trim()));
      const missing = options.languages.split("+").filter((language) => !installed.has(language));
      if (missing.length > 0) {
        throw new Error(`PII_PDF_OCR_LANGUAGES names languages that tesseract does not have: ${missing.join(", ")}.`);
      }
    }
  });
}

/**
 * Limits the OCR passes that run at the same time in this process. A full
 * wait queue refuses at once (`busy`); an aborted waiter leaves the queue.
 */
class OcrSlots {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(private readonly limit: number, private readonly maxWaiting: number) {}

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new OcrError("budget", "slot"));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxWaiting) return Promise.reject(new OcrError("busy", "slot"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new OcrError("budget", "slot"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    // The slot passes straight to the next waiter: `active` stays the same.
    if (next) next.grant();
    else this.active -= 1;
  }
}

// The tools get only the variables that they need, not the secrets in the
// backend environment.
function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TESSDATA_PREFIX"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/**
 * Spawns without a shell, ignores stdin and stderr, and caps stdout. On abort
 * or an output overrun it sends SIGKILL, then settles only on `close`, after
 * the child has exited.
 */
export const runBoundedBinary: RunBinary = (file, args, { signal, maxOutputBytes, env }) =>
  new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"], env: env ?? toolEnv(), shell: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const kill = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const onAbort = () => kill(new Error(`${path.basename(file)} aborted`));
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) kill(new Error(`${path.basename(file)} output limit`));
      else chunks.push(chunk);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${path.basename(file)} exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
