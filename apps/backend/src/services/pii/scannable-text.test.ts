import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { expect, test, vi } from "vitest";

import { ArtifactProcessor } from "../artifacts/artifact-processor.js";

import { DEFAULT_PII_PROTECTION } from "@cogniplane/shared-types";

import { createPdfOcr, type PdfOcr, type PdfOcrResult } from "./pdf-ocr.js";
import { PiiProtectionService, PiiProtectionServiceError } from "./pii-protection-service.js";
import { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";
import { imageCoverageDetail, toScannableText } from "./scannable-text.js";

test("decodes non-PDF content as UTF-8 text", async () => {
  expect(await toScannableText("application/x-sh", Buffer.from("echo hi"), {})).toEqual({ text: "echo hi" });
});

test("scans a PDF through its extracted text and marks it text-only without OCR", async () => {
  const result = await toScannableText("application/pdf; charset=binary", Buffer.from("%PDF"),
    { extractPdfText: async () => "Contact jane@example.com" });
  expect(result).toEqual({ text: "Contact jane@example.com", imageCoverage: { imageScan: "not_scanned" } });
});

test.each([
  ["no extractor is configured", undefined, "unsupported_mime"],
  ["extraction fails", async () => { throw new Error("pdftotext failed"); }, "pdf_extraction_failed"]
] as const)("rejects a PDF when %s", async (_case, extractPdfText, code) => {
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), { extractPdfText }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PiiProtectionServiceError);
  expect((error as PiiProtectionServiceError).code).toBe(code);
});

test("rejects a PDF whose extracted text is only whitespace", async () => {
  // pdftotext prints a form feed for a page with no text.
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), { extractPdfText: async () => "\f\n " })
    .catch((e: unknown) => e);
  expect((error as PiiProtectionServiceError).code).toBe("pdf_extraction_failed");
});

test("passes the evaluation signal to the extractor and keeps an abort as an abort", async () => {
  const controller = new AbortController();
  const abort = new DOMException("PII artifact evaluation timeout", "AbortError");
  const extractor = vi.fn(async (_pdf: Buffer, signal?: AbortSignal) => {
    controller.abort(abort);
    signal?.throwIfAborted();
    return "never";
  });
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), { extractPdfText: extractor }, controller.signal)
    .catch((e: unknown) => e);
  expect(extractor).toHaveBeenCalledWith(expect.any(Buffer), controller.signal);
  expect(error).toBe(abort);
});

function fakeOcr(result: Partial<PdfOcrResult>): PdfOcr {
  return async () => ({ text: "", status: "complete", pagesScanned: 1, pageCount: 1, ...result });
}

test("adds the OCR text of a mixed PDF after its extracted text", async () => {
  const result = await toScannableText("application/pdf", Buffer.from("%PDF"), {
    extractPdfText: async () => "Quarterly report\f",
    ocrPdf: fakeOcr({ text: "Signed by jane@example.com", pagesScanned: 2, pageCount: 2 })
  });
  expect(result).toEqual({
    text: "Quarterly report\n\nSigned by jane@example.com",
    imageCoverage: { imageScan: "complete", pagesScanned: 2, pageCount: 2 }
  });
});

test("scans an image-only PDF through its OCR text", async () => {
  const result = await toScannableText("application/pdf", Buffer.from("%PDF"), {
    extractPdfText: async () => "\f",
    ocrPdf: fakeOcr({ text: "Call 555-123-4567" })
  });
  expect(result.text).toBe("Call 555-123-4567");
  expect(result.imageCoverage?.imageScan).toBe("complete");
});

test("keeps the text of the pages that OCR read when the pass is partial", async () => {
  const result = await toScannableText("application/pdf", Buffer.from("%PDF"), {
    extractPdfText: async () => "",
    ocrPdf: fakeOcr({ text: "page one", status: "partial", pagesScanned: 1, pageCount: 40, reason: "page_limit" })
  });
  expect(result).toEqual({
    text: "page one",
    imageCoverage: { imageScan: "partial", pagesScanned: 1, pageCount: 40, reason: "page_limit" }
  });
});

test("rejects a PDF when neither the text nor OCR gives text", async () => {
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), {
    extractPdfText: async () => "\f",
    ocrPdf: fakeOcr({ text: " ", status: "failed", pagesScanned: 0, reason: "error" })
  }).catch((e: unknown) => e);
  expect((error as PiiProtectionServiceError).code).toBe("pdf_extraction_failed");
});

test("keeps an evaluation abort during OCR as an abort", async () => {
  const abort = new DOMException("PII artifact evaluation timeout", "AbortError");
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), {
    extractPdfText: async () => "text",
    ocrPdf: async () => { throw abort; }
  }).catch((e: unknown) => e);
  expect(error).toBe(abort);
});

test.each([
  [undefined, {}],
  [{ imageScan: "not_scanned" as const }, { imagesNotScanned: true }],
  [{ imageScan: "complete" as const, pagesScanned: 3, pageCount: 3 },
    { imageScan: "complete", imagePagesScanned: 3, imagePageCount: 3 }],
  [{ imageScan: "partial" as const, pagesScanned: 20, pageCount: 50, reason: "page_limit" as const },
    { imagesNotScanned: true, imageScan: "partial", imagePagesScanned: 20, imagePageCount: 50 }],
  [{ imageScan: "failed" as const, pagesScanned: 0, reason: "error" as const },
    { imagesNotScanned: true, imageScan: "failed", imagePagesScanned: 0 }]
])("stores coverage %j as %j", (coverage, detail) => {
  expect(imageCoverageDetail(coverage)).toEqual(detail);
});

// A PDF with a valid xref, built from its object bodies (object 1 first).
function buildPdf(objects: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let size = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(size);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "latin1"),
      typeof object === "string" ? Buffer.from(object, "latin1") : object,
      Buffer.from("\nendobj\n", "latin1")
    ]);
    parts.push(part);
    size += part.length;
  });
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  trailer += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(trailer, "latin1")]);
}

// One page with one line of real text.
function textPdf(line: string): Buffer {
  const content = `BT /F1 20 Tf 40 400 Td (${line}) Tj ET`;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]);
}

// The same page as a scan: pdftoppm renders the text PDF to a grayscale
// raster, and the new PDF holds only that image.
function scannedPdf(line: string): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pii-ocr-fixture-"));
  try {
    writeFileSync(path.join(dir, "text.pdf"), textPdf(line));
    const render = spawnSync("pdftoppm", ["-r", "300", "-gray", "-singlefile", path.join(dir, "text.pdf"), path.join(dir, "page")]);
    if (render.status !== 0) throw new Error("pdftoppm failed");
    const pgm = readFileSync(path.join(dir, "page.pgm"));
    const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0, 64).toString("latin1"));
    if (!header) throw new Error("unexpected PGM header");
    const [width, height] = [Number(header[1]), Number(header[2])];
    const pixels = deflateSync(pgm.subarray(header[0].length));
    const draw = "q 612 0 0 792 0 0 cm /Im0 Do Q";
    return buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
      Buffer.concat([
        Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray ` +
          `/BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`, "latin1"),
        pixels,
        Buffer.from("\nendstream", "latin1")
      ]),
      `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One page that draws a 1x1 image and holds no text, built with a valid xref.
function imageOnlyPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\u0000\nendstream",
    "<< /Length 32 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream"
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;

test.skipIf(!hasPdftotext)("rejects a real image-only PDF read by pdftotext", async () => {
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: { warn() {}, error() {} },
    storage: { openReadStream: async () => { throw new Error("unused"); } }
  });
  const error = await toScannableText("application/pdf", imageOnlyPdf(),
    { extractPdfText: (pdf, signal) => processor.extractPdfText(pdf, signal) }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PiiProtectionServiceError);
  expect((error as PiiProtectionServiceError).code).toBe("pdf_extraction_failed");
});

const hasOcrTools = hasPdftotext && ["pdftoppm", "pdfinfo", "tesseract"]
  .every((tool) => spawnSync(tool, [tool === "tesseract" ? "--version" : "-v"]).error === undefined);

// Runs where poppler-utils and tesseract (with English data) are installed,
// for example the backend image. It checks the real tools end to end.
test.skipIf(!hasOcrTools)("OCR reads PII from a real scanned PDF, and block mode blocks it", async () => {
  const processor = new ArtifactProcessor({
    config: { PDFTOTEXT_BINARY_PATH: "pdftotext" },
    logger: { warn() {}, error() {} },
    storage: { openReadStream: async () => { throw new Error("unused"); } }
  });
  const extractPdfText = (pdf: Buffer, signal?: AbortSignal) => processor.extractPdfText(pdf, signal);
  const ocrPdf = createPdfOcr({
    pdfinfoPath: "pdfinfo", pdftoppmPath: "pdftoppm", tesseractPath: "tesseract", languages: "eng",
    maxPages: 5, timeoutMs: 30_000, maxConcurrent: 1, maxTextBytes: 1024 * 1024
  });
  await ocrPdf.verify();
  const pdf = scannedPdf("Contact jane.doe@example.com today");

  // Without OCR the scan has no text: the file is rejected, as before.
  expect(await extractPdfText(pdf)).toBe("");
  const scannable = await toScannableText("application/pdf", pdf, { extractPdfText, ocrPdf });
  expect(scannable.text).toContain("jane.doe@example.com");
  expect(scannable.imageCoverage).toEqual({ imageScan: "complete", pagesScanned: 1, pageCount: 1 });

  const service = new PiiProtectionService({
    policyReader: { readPiiProtection: async () => ({ stored: { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block", scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: true } }, revision: 1 }) },
    ruleDetector: new RuleBasedPiiDetector(),
    timeoutMs: 5000,
    pdfOcrBudgetMs: 30_000
  });
  const decision = await service.evaluateArtifact({
    tenantId: "t1",
    subject: { kind: "upload" },
    artifact: {
      artifactId: "art_1", contentType: "application/pdf", entityTypes: [],
      readContent: async () => scannable.text,
      imageCoverage: () => scannable.imageCoverage
    }
  });
  expect(decision).toMatchObject({ action: "block", blockReason: "email" });
}, 60_000);
