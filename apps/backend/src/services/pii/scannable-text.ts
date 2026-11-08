import type { ArtifactPiiDetail } from "../artifacts/artifact-store.js";
import { isPdfContentType, type PdfOcr } from "./pdf-ocr.js";
import { PiiProtectionServiceError } from "./pii-protection-service.js";
import type { PdfImageCoverage } from "./pii-provider.js";

export type PdfTextExtractor = (pdf: Buffer, signal?: AbortSignal) => Promise<string>;

export interface PdfScanTools {
  /** Without it, a PDF is rejected as unscannable. */
  extractPdfText?: PdfTextExtractor;
  /** Without it, the scan reads only the text of a PDF. */
  ocrPdf?: PdfOcr;
}

export interface ScannableText {
  text: string;
  /** Set for a PDF. */
  imageCoverage?: PdfImageCoverage;
}

/**
 * Convert stored bytes to the text that the PII scan reads. A PDF is scanned
 * through its extracted text and, when OCR is on, the OCR text of its pages;
 * every other scannable type is UTF-8 text. `PiiProtectionService` rejects
 * unscannable types before it reads content.
 *
 * A PDF with no readable text (a scan or an image-only PDF without OCR) is
 * rejected: an empty scan would allow content that nobody checked.
 */
export async function toScannableText(
  contentType: string,
  bytes: Buffer,
  tools: PdfScanTools,
  signal?: AbortSignal
): Promise<ScannableText> {
  if (!isPdfContentType(contentType)) return { text: bytes.toString("utf8") };
  if (!tools.extractPdfText) {
    throw new PiiProtectionServiceError(
      "unsupported_mime",
      "PII protection cannot scan PDF files on this server because PDF text extraction is not configured."
    );
  }
  let text: string;
  try {
    text = await tools.extractPdfText(bytes, signal);
  } catch (error) {
    // A timeout of the PII evaluation is not a verdict on the file.
    if (signal?.aborted) throw error;
    throw new PiiProtectionServiceError(
      "pdf_extraction_failed",
      "PII protection could not read the text of this PDF, so the file was not accepted."
    );
  }

  if (!tools.ocrPdf) {
    if (text.trim() === "") {
      throw new PiiProtectionServiceError(
        "pdf_extraction_failed",
        "This PDF has no text that PII protection can read (for example, a scanned or image-only PDF), so the file was not accepted."
      );
    }
    return { text, imageCoverage: { imageScan: "not_scanned" } };
  }

  // An outer abort (the evaluation timeout) throws here: it is not a verdict.
  const ocr = await tools.ocrPdf(bytes, signal);
  const combined = [text.trim(), ocr.text.trim()].filter((part) => part !== "").join("\n\n");
  if (combined === "") {
    throw new PiiProtectionServiceError(
      "pdf_extraction_failed",
      "This PDF has no text that PII protection can read, even with OCR, so the file was not accepted."
    );
  }
  return {
    text: combined,
    imageCoverage: {
      imageScan: ocr.status,
      pagesScanned: ocr.pagesScanned,
      ...(ocr.pageCount !== undefined ? { pageCount: ocr.pageCount } : {}),
      ...(ocr.reason ? { reason: ocr.reason } : {})
    }
  };
}

/** The coverage fields of a PII detail. Every incomplete scan keeps `imagesNotScanned`. */
export type ImageCoverageDetail = Pick<
  ArtifactPiiDetail,
  "imagesNotScanned" | "imageScan" | "imagePagesScanned" | "imagePageCount"
>;

export function imageCoverageDetail(coverage: PdfImageCoverage | undefined): ImageCoverageDetail {
  if (!coverage) return {};
  if (coverage.imageScan === "not_scanned") return { imagesNotScanned: true };
  return {
    ...(coverage.imageScan === "complete" ? {} : { imagesNotScanned: true }),
    imageScan: coverage.imageScan,
    ...(coverage.pagesScanned !== undefined ? { imagePagesScanned: coverage.pagesScanned } : {}),
    ...(coverage.pageCount !== undefined ? { imagePageCount: coverage.pageCount } : {})
  };
}
