import type { PiiEntityType } from "@cogniplane/shared-types";

import type { PdfOcrIncompleteReason, PdfOcrStatus } from "./pdf-ocr.js";

export type PiiFindingConfidence = "low" | "medium" | "high";

export interface PiiFinding {
  entityType: PiiEntityType;
  value: string;
  start: number;
  end: number;
  confidence: PiiFindingConfidence;
}

export interface PiiDetectionResult {
  findings: PiiFinding[];
  providerType: string;
  providerModel: string | null;
}

export interface PiiTransformResult {
  transformedText: string;
  findings: PiiFinding[];
  providerType: string;
  providerModel: string | null;
}

export interface PiiArtifactScanResult {
  findings: PiiFinding[];
  summaryText: string | null;
  providerType: string;
  providerModel: string | null;
}

export interface PiiDetectTextInput {
  text: string;
  entityTypes: PiiEntityType[];
  /** Optional per-call model override; falls back to the provider's default. */
  model?: string;
}

export interface PiiTransformTextInput {
  text: string;
  entityTypes: PiiEntityType[];
  /** Optional per-call model override; falls back to the provider's default. */
  model?: string;
}

/**
 * The image coverage of a PDF scan. `not_scanned`: OCR is off, so the scan
 * read only the text. Otherwise the status of the OCR pass over the pages.
 */
export interface PdfImageCoverage {
  imageScan: "not_scanned" | PdfOcrStatus;
  pagesScanned?: number;
  pageCount?: number;
  /** Internal. Not stored. */
  reason?: PdfOcrIncompleteReason;
}

export interface PiiScanArtifactInput {
  artifactId: string;
  contentType: string;
  /** The signal aborts when the PII evaluation times out. */
  readContent: (signal?: AbortSignal) => Promise<string>;
  /**
   * What the scan read of a PDF's pages beyond its text. Read it after
   * `readContent`. Undefined for a file that is not a PDF.
   */
  imageCoverage?: () => PdfImageCoverage | undefined;
  entityTypes: PiiEntityType[];
  /** Optional per-call model override; falls back to the provider's default. */
  model?: string;
}

export interface PiiScanCsvPreviewInput {
  artifactId: string;
  /**
   * The first N rows of the CSV (header + a small sample), already trimmed
   * to the configured byte budget. The provider does not re-trim.
   */
  preview: string;
  entityTypes: PiiEntityType[];
  model?: string;
}

export interface PiiProvider {
  readonly type: string;
  detectText(input: PiiDetectTextInput, signal?: AbortSignal): Promise<PiiDetectionResult>;
  transformText(input: PiiTransformTextInput, signal?: AbortSignal): Promise<PiiTransformResult>;
  scanArtifact(input: PiiScanArtifactInput, signal?: AbortSignal): Promise<PiiArtifactScanResult>;
  /**
   * Optional. CSV-aware preview scan: same return shape as scanArtifact but
   * uses a column-oriented prompt and accepts a pre-trimmed preview string
   * instead of streaming full content. Returned findings have synthetic
   * offsets (0,0) since the preview is not the full file.
   */
  scanCsvPreview?(
    input: PiiScanCsvPreviewInput,
    signal?: AbortSignal
  ): Promise<PiiArtifactScanResult>;
}
