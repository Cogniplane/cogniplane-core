import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { createPdfOcr, normalizeOcrText, runBoundedBinary, type PdfOcrOptions, type RunBinary } from "./pdf-ocr.js";

type Call = { file: string; args: string[]; env?: NodeJS.ProcessEnv };

// A fake toolset: `pages` page texts, and per-call hooks to fail or hang.
function fakeTools(opts: {
  info?: string;
  pages?: string[];
  onTesseract?: (page: number, signal: AbortSignal) => Promise<string> | undefined;
  failPdfinfo?: boolean;
}) {
  const calls: Call[] = [];
  let inputDir: string | undefined;
  let active = 0;
  let maxActive = 0;
  const runBinary: RunBinary = async (file, args, { signal, env }) => {
    calls.push({ file, args, env });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (file === "pdfinfo") {
        inputDir = path.dirname(args[0]!);
        if (opts.failPdfinfo) throw new Error("Syntax Error: jane.doe@example.com");
        return opts.info ?? `Title: x\nPages:          ${opts.pages?.length ?? 1}\n`;
      }
      if (file === "pdftoppm") return "";
      const page = Number(path.basename(args[0]!) === "page.png" ? lastPage(calls) : Number.NaN);
      const hooked = opts.onTesseract?.(page, signal);
      if (hooked) return await hooked;
      return opts.pages?.[page - 1] ?? "";
    } finally {
      active -= 1;
    }
  };
  return { calls, runBinary, inputDir: () => inputDir, maxActive: () => maxActive };
}

function lastPage(calls: Call[]): number {
  const render = calls.filter((call) => call.file === "pdftoppm").at(-1)!;
  return Number(render.args[render.args.indexOf("-f") + 1]);
}

function ocr(tools: { runBinary: RunBinary }, options: Partial<PdfOcrOptions> = {}) {
  const warnings: unknown[] = [];
  const pdfOcr = createPdfOcr({
    pdfinfoPath: "pdfinfo",
    pdftoppmPath: "pdftoppm",
    tesseractPath: "tesseract",
    languages: "eng",
    maxPages: 20,
    timeoutMs: 5_000,
    maxConcurrent: 2,
    maxTextBytes: 1024 * 1024,
    logger: { warn: (payload) => warnings.push(payload) },
    runBinary: tools.runBinary,
    ...options
  });
  return { pdfOcr, warnings };
}

// Waits until the signal aborts, as a killed tool does.
function hangUntilAbort(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("killed"));
    signal.addEventListener("abort", () => reject(new Error("killed")), { once: true });
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("reads every page and reports complete coverage", async () => {
  vi.stubEnv("DATABASE_URL", "postgres://secret");
  const tools = fakeTools({ pages: ["Page one\n", "Page two jane@example.com\n"] });
  const { pdfOcr, warnings } = ocr(tools);

  const result = await pdfOcr(Buffer.from("%PDF"));

  expect(result).toEqual({ text: "Page one\n\nPage two jane@example.com", status: "complete", pagesScanned: 2, pageCount: 2 });
  expect(warnings).toEqual([]);
  const renders = tools.calls.filter((call) => call.file === "pdftoppm").map((call) => call.args.slice(0, 4));
  expect(renders).toEqual([["-f", "1", "-l", "1"], ["-f", "2", "-l", "2"]]);
  const recognize = tools.calls.find((call) => call.file === "tesseract")!;
  expect(recognize.args).toEqual([expect.stringMatching(/page\.png$/), "stdout", "-l", "eng", "--psm", "3"]);
  expect(recognize.env?.OMP_THREAD_LIMIT).toBe("1");
  expect(recognize.env).not.toHaveProperty("DATABASE_URL");
  expect(existsSync(tools.inputDir()!)).toBe(false);
});

test("stops at the page limit with partial coverage", async () => {
  const tools = fakeTools({ pages: ["a", "b", "c", "d", "e"] });
  const { pdfOcr, warnings } = ocr(tools, { maxPages: 2 });
  const result = await pdfOcr(Buffer.from("%PDF"));
  expect(result).toEqual({ text: "a\n\nb", status: "partial", pagesScanned: 2, pageCount: 5, reason: "page_limit" });
  expect(warnings).toEqual([expect.objectContaining({ reason: "page_limit", pagesScanned: 2, pageCount: 5 })]);
});

test("stops at the text limit with partial coverage", async () => {
  const tools = fakeTools({ pages: ["x".repeat(10), "y".repeat(10), "z"] });
  const result = await ocr(tools, { maxTextBytes: 15 }).pdfOcr(Buffer.from("%PDF"));
  expect(result).toMatchObject({ status: "partial", pagesScanned: 2, pageCount: 3, reason: "text_limit" });
});

test("a budget that runs out after a page gives partial coverage and kills the running tool", async () => {
  let killed = false;
  const tools = fakeTools({
    pages: ["first", "second"],
    onTesseract: (page, signal) => page === 2
      ? hangUntilAbort(signal).catch((error: unknown) => { killed = true; throw error; })
      : undefined
  });
  const result = await ocr(tools, { timeoutMs: 50 }).pdfOcr(Buffer.from("%PDF"));
  expect(result).toEqual({ text: "first", status: "partial", pagesScanned: 1, pageCount: 2, reason: "budget" });
  expect(killed).toBe(true);
  expect(existsSync(tools.inputDir()!)).toBe(false);
});

test("a budget that runs out before the first page fails", async () => {
  const tools = fakeTools({ pages: ["first"], onTesseract: (_page, signal) => hangUntilAbort(signal) });
  const result = await ocr(tools, { timeoutMs: 30 }).pdfOcr(Buffer.from("%PDF"));
  expect(result).toMatchObject({ status: "failed", pagesScanned: 0, reason: "budget" });
});

test("a tool error fails the pass, keeps the pages read, and logs no tool output", async () => {
  const tools = fakeTools({
    pages: ["first", "second"],
    onTesseract: (page) => page === 2 ? Promise.reject(new Error("Error in pixReadStream: jane.doe@example.com")) : undefined
  });
  const { pdfOcr, warnings } = ocr(tools);
  const result = await pdfOcr(Buffer.from("%PDF"));
  expect(result).toEqual({ text: "first", status: "failed", pagesScanned: 1, pageCount: 2, reason: "error" });
  expect(warnings).toEqual([expect.objectContaining({ reason: "error", step: "tesseract" })]);
  expect(JSON.stringify(warnings)).not.toContain("example.com");
  expect(existsSync(tools.inputDir()!)).toBe(false);
});

test.each([
  ["pdfinfo fails", { failPdfinfo: true }],
  ["pdfinfo gives no page count", { info: "Title: x\n" }],
  ["pdfinfo gives zero pages", { info: "Pages: 0\n" }]
])("fails without a page count when %s", async (_case, opts) => {
  const tools = fakeTools(opts);
  const { pdfOcr, warnings } = ocr(tools);
  const result = await pdfOcr(Buffer.from("%PDF"));
  expect(result).toEqual({ text: "", status: "failed", pagesScanned: 0, reason: "error" });
  expect(JSON.stringify(warnings)).not.toContain("example.com");
  expect(existsSync(tools.inputDir()!)).toBe(false);
});

test("an abort of the evaluation is rethrown, not reported as coverage", async () => {
  const controller = new AbortController();
  const reason = new DOMException("PII artifact evaluation timeout", "AbortError");
  const tools = fakeTools({
    pages: ["first"],
    onTesseract: (_page, signal) => {
      controller.abort(reason);
      return hangUntilAbort(signal);
    }
  });
  const { pdfOcr, warnings } = ocr(tools);
  await expect(pdfOcr(Buffer.from("%PDF"), controller.signal)).rejects.toBe(reason);
  expect(warnings).toEqual([]);
  expect(existsSync(tools.inputDir()!)).toBe(false);
});

test("passes run one at a time per slot, and a waiter's time counts against its budget", async () => {
  let release!: () => void;
  const gate = new Promise<string>((resolve) => { release = () => resolve("first"); });
  let tesseractCalls = 0;
  const tools = fakeTools({
    pages: ["x"],
    onTesseract: () => (tesseractCalls += 1) === 1 ? gate : undefined
  });
  const { pdfOcr } = ocr(tools, { maxConcurrent: 1, timeoutMs: 100 });
  const first = pdfOcr(Buffer.from("%PDF"));
  // The second pass waits for the slot until its budget runs out.
  const second = await pdfOcr(Buffer.from("%PDF"));
  expect(second).toMatchObject({ status: "failed", pagesScanned: 0, reason: "budget" });
  release();
  expect(await first).toMatchObject({ status: "complete", text: "first" });
  expect(tools.maxActive()).toBe(1);
  // The slot is free again.
  expect(await pdfOcr(Buffer.from("%PDF"))).toMatchObject({ status: "complete" });
});

test("a full wait queue refuses at once as busy", async () => {
  let release!: () => void;
  const gate = new Promise<string>((resolve) => { release = () => resolve("x"); });
  const tools = fakeTools({ pages: ["x"], onTesseract: () => gate });
  const { pdfOcr } = ocr(tools, { maxConcurrent: 1 });
  // One pass runs and eight wait (the queue holds eight per slot).
  const running = Array.from({ length: 9 }, () => pdfOcr(Buffer.from("%PDF")));
  const refused = await pdfOcr(Buffer.from("%PDF"));
  expect(refused).toMatchObject({ status: "failed", pagesScanned: 0, reason: "busy" });
  release();
  const results = await Promise.all(running);
  expect(results.every((result) => result.status === "complete")).toBe(true);
});

test("verify checks the tools and each configured language", async () => {
  const runBinary: RunBinary = async (file) => file === "tesseract" ? "List of available languages (2):\neng\nosd\n" : "";
  await expect(ocr({ runBinary }).pdfOcr.verify()).resolves.toBeUndefined();
  await expect(ocr({ runBinary }, { languages: "eng+fra" }).pdfOcr.verify()).rejects.toThrow(/fra/);
  const missingTool: RunBinary = async (file) => {
    if (file === "pdftoppm") throw new Error("ENOENT");
    return "eng\n";
  };
  await expect(ocr({ runBinary: missingTool }).pdfOcr.verify()).rejects.toThrow(/pdftoppm/);
});

test.each([
  ["Contact jane.doe@ example.com today", "Contact jane.doe@example.com today"],
  ["jane.doe @example.com", "jane.doe@example.com"],
  ["a\t@\tb.co", "a@b.co"],
  ["line ends with jane@\nexample.com", "line ends with jane@\nexample.com"],
  ["@ start and end @", "@ start and end @"],
  ["  page text \n", "page text"]
])("normalizes OCR text %j", (input, output) => {
  expect(normalizeOcrText(input)).toBe(output);
});

const node = process.execPath;
const limits = (signal = new AbortController().signal) => ({ signal, maxOutputBytes: 1024 });

test("runBoundedBinary returns stdout and ignores stderr", async () => {
  const out = await runBoundedBinary(node, ["-e", "process.stdout.write('ok'); process.stderr.write('secret')"], limits());
  expect(out).toBe("ok");
});

test("runBoundedBinary rejects a non-zero exit without the tool output", async () => {
  const error = await runBoundedBinary(node, ["-e", "process.stderr.write('jane@example.com'); process.exit(3)"], limits())
    .catch((e: unknown) => e as Error);
  expect((error as Error).message).toMatch(/code 3/);
  expect((error as Error).message).not.toContain("example.com");
});

test("runBoundedBinary kills a tool whose output passes the limit", async () => {
  const error = await runBoundedBinary(node, ["-e", "setInterval(() => process.stdout.write('x'.repeat(512)), 1)"], limits())
    .catch((e: unknown) => e as Error);
  expect((error as Error).message).toMatch(/output limit/);
});

test("runBoundedBinary kills the tool on abort and settles after it exits", async () => {
  const controller = new AbortController();
  const pending = runBoundedBinary(node, ["-e", "setInterval(() => {}, 1000)"], limits(controller.signal));
  setTimeout(() => controller.abort(), 50);
  await expect(pending).rejects.toThrow(/aborted/);
});

test("runBoundedBinary rejects a missing binary", async () => {
  await expect(runBoundedBinary("/nonexistent/tesseract", [], limits())).rejects.toThrow();
});
