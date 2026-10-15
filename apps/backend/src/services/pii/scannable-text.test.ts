import { spawnSync } from "node:child_process";

import { expect, test, vi } from "vitest";

import { ArtifactProcessor } from "../artifacts/artifact-processor.js";

import { PiiProtectionServiceError } from "./pii-protection-service.js";
import { toScannableText } from "./scannable-text.js";

test("decodes non-PDF content as UTF-8 text", async () => {
  expect(await toScannableText("application/x-sh", Buffer.from("echo hi"), undefined)).toBe("echo hi");
});

test("scans a PDF through its extracted text", async () => {
  const text = await toScannableText("application/pdf; charset=binary", Buffer.from("%PDF"),
    async () => "Contact jane@example.com");
  expect(text).toBe("Contact jane@example.com");
});

test.each([
  ["no extractor is configured", undefined, "unsupported_mime"],
  ["extraction fails", async () => { throw new Error("pdftotext failed"); }, "pdf_extraction_failed"]
] as const)("rejects a PDF when %s", async (_case, extractPdfText, code) => {
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), extractPdfText).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PiiProtectionServiceError);
  expect((error as PiiProtectionServiceError).code).toBe(code);
});

test("rejects a PDF whose extracted text is only whitespace", async () => {
  // pdftotext prints a form feed for a page with no text.
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), async () => "\f\n ")
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
  const error = await toScannableText("application/pdf", Buffer.from("%PDF"), extractor, controller.signal)
    .catch((e: unknown) => e);
  expect(extractor).toHaveBeenCalledWith(expect.any(Buffer), controller.signal);
  expect(error).toBe(abort);
});

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
    (pdf, signal) => processor.extractPdfText(pdf, signal)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PiiProtectionServiceError);
  expect((error as PiiProtectionServiceError).code).toBe("pdf_extraction_failed");
});
