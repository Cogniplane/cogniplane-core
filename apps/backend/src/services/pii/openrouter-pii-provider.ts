import type { PiiCircuitBreaker } from "./pii-circuit-breaker.js";
import type { PiiEntityType } from "./pii-policy.js";
import type {
  PiiArtifactScanResult,
  PiiDetectTextInput,
  PiiDetectionResult,
  PiiFinding,
  PiiFindingConfidence,
  PiiProvider,
  PiiScanArtifactInput,
  PiiScanCsvPreviewInput,
  PiiTransformResult,
  PiiTransformTextInput
} from "./pii-provider.js";
import { PII_ENTITY_TYPES } from "./pii-policy.js";

export interface OpenRouterPiiProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  appUrl?: string;
  appTitle?: string;
  /** When provided, calls are gated by the breaker and outcomes recorded. */
  breaker?: PiiCircuitBreaker;
}

interface OpenRouterChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterChatRequest {
  model: string;
  messages: OpenRouterChatMessage[];
  temperature?: number;
  response_format?: { type: "json_object" };
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
  error?: { message?: string; code?: string | number };
}

interface RawFinding {
  entityType?: string;
  value?: string;
  start?: number;
  end?: number;
  confidence?: string;
}

interface RawDetectionResponse {
  findings?: RawFinding[];
}

interface RawTransformResponse {
  transformedText?: string;
  findings?: RawFinding[];
}

interface RawArtifactResponse {
  findings?: RawFinding[];
  summary?: string;
}

export class OpenRouterPiiProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenRouterPiiProviderError";
    this.code = code;
  }
}

const VALID_ENTITY_TYPES = new Set<PiiEntityType>(PII_ENTITY_TYPES);

export class OpenRouterPiiProvider implements PiiProvider {
  readonly type = "openrouter";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly appUrl?: string;
  private readonly appTitle?: string;
  private readonly breaker?: PiiCircuitBreaker;

  constructor(options: OpenRouterPiiProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch ?? fetch;
    this.appUrl = options.appUrl;
    this.appTitle = options.appTitle;
    this.breaker = options.breaker;
  }

  async detectText(
    input: PiiDetectTextInput,
    signal?: AbortSignal
  ): Promise<PiiDetectionResult> {
    const model = input.model ?? this.model;
    const raw = await this.callChat<RawDetectionResponse>(
      [
        { role: "system", content: detectSystemPrompt(input.entityTypes) },
        { role: "user", content: input.text }
      ],
      signal,
      model
    );

    return {
      findings: normalizeFindings(raw.findings, input.text, input.entityTypes),
      providerType: this.type,
      providerModel: model
    };
  }

  async transformText(
    input: PiiTransformTextInput,
    signal?: AbortSignal
  ): Promise<PiiTransformResult> {
    const model = input.model ?? this.model;
    const raw = await this.callChat<RawTransformResponse>(
      [
        { role: "system", content: transformSystemPrompt(input.entityTypes) },
        { role: "user", content: input.text }
      ],
      signal,
      model
    );

    const findings = normalizeFindings(raw.findings, input.text, input.entityTypes);

    // A missing `transformedText` is only safe when the model also reported no
    // findings — then "no change" genuinely means "nothing to redact". If the
    // model flagged PII but gave us no redacted text, falling back to the raw
    // input would forward unredacted PII while claiming a transform happened.
    // Fail the call so the service fails closed instead.
    if (typeof raw.transformedText !== "string") {
      if (findings.length > 0) {
        throw new OpenRouterPiiProviderError(
          "transform_missing_output",
          "OpenRouter reported findings but returned no transformedText"
        );
      }
      return {
        transformedText: input.text,
        findings,
        providerType: this.type,
        providerModel: model
      };
    }

    return {
      transformedText: raw.transformedText,
      findings,
      providerType: this.type,
      providerModel: model
    };
  }

  async scanArtifact(
    input: PiiScanArtifactInput,
    signal?: AbortSignal
  ): Promise<PiiArtifactScanResult> {
    const model = input.model ?? this.model;
    const content = await input.readContent();
    const raw = await this.callChat<RawArtifactResponse>(
      [
        { role: "system", content: artifactSystemPrompt(input.entityTypes) },
        {
          role: "user",
          content: `Artifact id: ${input.artifactId}\nContent-Type: ${input.contentType}\n\n${content}`
        }
      ],
      signal,
      model
    );

    return {
      findings: normalizeFindings(raw.findings, content, input.entityTypes),
      summaryText: typeof raw.summary === "string" ? raw.summary : null,
      providerType: this.type,
      providerModel: model
    };
  }

  async scanCsvPreview(
    input: PiiScanCsvPreviewInput,
    signal?: AbortSignal
  ): Promise<PiiArtifactScanResult> {
    const model = input.model ?? this.model;
    const raw = await this.callChat<RawArtifactResponse>(
      [
        { role: "system", content: csvPreviewSystemPrompt(input.entityTypes) },
        {
          role: "user",
          content: `Artifact id: ${input.artifactId}\n\n${input.preview}`
        }
      ],
      signal,
      model
    );

    // Offsets from a preview can't reference the full file, so strip them.
    // We keep entityType + value (subject to retention policy upstream) and
    // a synthetic 0,0 span so admin reads still see "PII of type X exists."
    const findings: PiiFinding[] = (raw.findings ?? [])
      .filter((f): f is { entityType: string; value?: string } =>
        typeof f.entityType === "string"
      )
      .filter((f) => VALID_ENTITY_TYPES.has(f.entityType as PiiEntityType))
      .filter((f) => input.entityTypes.includes(f.entityType as PiiEntityType))
      .map((f) => ({
        entityType: f.entityType as PiiEntityType,
        value: typeof f.value === "string" ? f.value : "",
        start: 0,
        end: 0,
        confidence: "medium" as PiiFindingConfidence
      }));

    return {
      findings,
      summaryText: typeof raw.summary === "string" ? raw.summary : null,
      providerType: this.type,
      providerModel: model
    };
  }

  private async callChat<TResponse>(
    messages: OpenRouterChatMessage[],
    externalSignal: AbortSignal | undefined,
    model: string
  ): Promise<TResponse> {
    if (this.breaker && !(await this.breaker.shouldAllow())) {
      throw new OpenRouterPiiProviderError(
        "breaker_open",
        "PII provider circuit breaker is open; skipping call"
      );
    }
    try {
      const result = await this.doCallChat<TResponse>(messages, externalSignal, model);
      await this.breaker?.record("success");
      return result;
    } catch (error) {
      // Every OpenRouterPiiProviderError represents a real provider problem
      // (timeout / network / 5xx / malformed response). Count them all.
      // Non-OpenRouter errors (programmer errors, signal aborts from caller
      // unrelated to provider health) shouldn't count.
      if (error instanceof OpenRouterPiiProviderError && error.code !== "breaker_open") {
        await this.breaker?.record("failure");
      }
      throw error;
    }
  }

  private async doCallChat<TResponse>(
    messages: OpenRouterChatMessage[],
    externalSignal: AbortSignal | undefined,
    model: string
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timeout", "AbortError")), this.timeoutMs);
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };
    if (this.appUrl) headers["HTTP-Referer"] = this.appUrl;
    if (this.appTitle) headers["X-Title"] = this.appTitle;

    const body: OpenRouterChatRequest = {
      model,
      messages,
      temperature: 0,
      response_format: { type: "json_object" }
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new OpenRouterPiiProviderError("timeout", `OpenRouter request timed out after ${this.timeoutMs}ms`);
      }
      throw new OpenRouterPiiProviderError(
        "network_error",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OpenRouterPiiProviderError(
        "http_error",
        `OpenRouter returned ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const payload = (await response.json()) as OpenRouterChatResponse;
    if (payload.error) {
      throw new OpenRouterPiiProviderError(
        "provider_error",
        payload.error.message ?? "OpenRouter returned an error"
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new OpenRouterPiiProviderError("empty_response", "OpenRouter returned no message content");
    }

    try {
      return JSON.parse(content) as TResponse;
    } catch (error) {
      throw new OpenRouterPiiProviderError(
        "invalid_json",
        `OpenRouter response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

function detectSystemPrompt(entityTypes: PiiEntityType[]): string {
  return [
    "You detect personally identifiable information (PII) in user text.",
    `Return ONLY valid JSON of shape: {"findings": [{"entityType": string, "value": string, "start": number, "end": number, "confidence": "low"|"medium"|"high"}]}.`,
    `Allowed entityType values: ${entityTypes.join(", ")}.`,
    "start and end are 0-based character offsets into the input text.",
    "If no PII is present, return {\"findings\": []}."
  ].join(" ");
}

function transformSystemPrompt(entityTypes: PiiEntityType[]): string {
  return [
    "You redact personally identifiable information (PII) from user text.",
    "Replace each finding with a placeholder of the form [REDACTED:<entityType>].",
    `Return ONLY valid JSON of shape: {"transformedText": string, "findings": [{"entityType": string, "value": string, "start": number, "end": number, "confidence": "low"|"medium"|"high"}]}.`,
    `Allowed entityType values: ${entityTypes.join(", ")}.`,
    "Offsets refer to the original input text, not the transformed output.",
    "If no PII is present, return the original text unchanged and {\"findings\": []}."
  ].join(" ");
}

function csvPreviewSystemPrompt(entityTypes: PiiEntityType[]): string {
  return [
    "You scan a CSV preview (the header row plus a small sample of data rows) for personally identifiable information (PII).",
    "Identify PII per column based on column-name semantics AND the values in the sampled rows.",
    "Treat the FULL value of each cell as the PII value when a column contains PII — do not split into substrings.",
    `Return ONLY valid JSON of shape: {"findings": [{"entityType": string, "value": string, "confidence": "low"|"medium"|"high"}], "summary": string}.`,
    `Allowed entityType values: ${entityTypes.join(", ")}.`,
    "summary is a short natural-language description of the columns flagged.",
    "Do not include character offsets — the preview is not the full file.",
    "If no PII is present, return {\"findings\": [], \"summary\": \"No PII detected.\"}."
  ].join(" ");
}

function artifactSystemPrompt(entityTypes: PiiEntityType[]): string {
  return [
    "You scan the content of an uploaded artifact for personally identifiable information (PII).",
    `Return ONLY valid JSON of shape: {"findings": [{"entityType": string, "value": string, "start": number, "end": number, "confidence": "low"|"medium"|"high"}], "summary": string}.`,
    `Allowed entityType values: ${entityTypes.join(", ")}.`,
    "summary is a short natural-language description of the findings, safe to show administrators.",
    "If no PII is present, return {\"findings\": [], \"summary\": \"No PII detected.\"}."
  ].join(" ");
}

function normalizeFindings(
  raw: RawFinding[] | undefined,
  sourceText: string,
  allowedEntityTypes: PiiEntityType[]
): PiiFinding[] {
  if (!Array.isArray(raw)) return [];

  const allowed = new Set<PiiEntityType>(allowedEntityTypes);
  const findings: PiiFinding[] = [];

  for (const candidate of raw) {
    const entityType = candidate.entityType;
    if (!entityType || !VALID_ENTITY_TYPES.has(entityType as PiiEntityType)) continue;
    if (!allowed.has(entityType as PiiEntityType)) continue;
    const value = typeof candidate.value === "string" ? candidate.value : "";
    if (!value) continue;

    const offsets = clampOffsets(candidate.start, candidate.end, value, sourceText);
    if (!offsets) continue;

    findings.push({
      entityType: entityType as PiiEntityType,
      value,
      start: offsets.start,
      end: offsets.end,
      confidence: normalizeConfidence(candidate.confidence)
    });
  }

  return findings;
}

function clampOffsets(
  rawStart: number | undefined,
  rawEnd: number | undefined,
  value: string,
  sourceText: string
): { start: number; end: number } | null {
  const length = sourceText.length;
  const numericStart = Number.isInteger(rawStart) ? (rawStart as number) : -1;
  const numericEnd = Number.isInteger(rawEnd) ? (rawEnd as number) : -1;

  if (
    numericStart >= 0 &&
    numericEnd > numericStart &&
    numericEnd <= length &&
    sourceText.slice(numericStart, numericEnd) === value
  ) {
    return { start: numericStart, end: numericEnd };
  }

  const fallback = sourceText.indexOf(value);
  if (fallback >= 0) {
    return { start: fallback, end: fallback + value.length };
  }

  return null;
}

function normalizeConfidence(value: unknown): PiiFindingConfidence {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}
