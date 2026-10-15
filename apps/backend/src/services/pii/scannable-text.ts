import { PiiProtectionServiceError } from "./pii-protection-service.js";

export type PdfTextExtractor = (pdf: Buffer, signal?: AbortSignal) => Promise<string>;

/**
 * Convert stored bytes to the text that the PII scan reads. A PDF is scanned
 * through its extracted text; every other scannable type is UTF-8 text.
 * `PiiProtectionService` rejects unscannable types before it reads content.
 *
 * A PDF with no extractable text (a scan or an image-only PDF) is rejected:
 * an empty scan would allow content that nobody checked.
 */
export async function toScannableText(
  contentType: string,
  bytes: Buffer,
  extractPdfText: PdfTextExtractor | undefined,
  signal?: AbortSignal
): Promise<string> {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized !== "application/pdf") return bytes.toString("utf8");
  if (!extractPdfText) {
    throw new PiiProtectionServiceError(
      "unsupported_mime",
      "PII protection cannot scan PDF files on this server because PDF text extraction is not configured."
    );
  }
  let text: string;
  try {
    text = await extractPdfText(bytes, signal);
  } catch (error) {
    // A timeout of the PII evaluation is not a verdict on the file.
    if (signal?.aborted) throw error;
    throw new PiiProtectionServiceError(
      "pdf_extraction_failed",
      "PII protection could not read the text of this PDF, so the file was not accepted."
    );
  }
  if (text.trim() === "") {
    throw new PiiProtectionServiceError(
      "pdf_extraction_failed",
      "This PDF has no text that PII protection can read (for example, a scanned or image-only PDF), so the file was not accepted."
    );
  }
  return text;
}
