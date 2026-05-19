import {
  DEFAULT_PII_PROTECTION,
  type PiiMode,
  type PiiProtectionSettings
} from "./pii-policy.js";
import type { PiiFindingEncryptor } from "./pii-finding-encryption.js";
import type {
  PiiFinding,
  PiiProvider,
  PiiScanArtifactInput
} from "./pii-provider.js";
import type { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";

export interface PiiPolicyReader {
  /**
   * Resolves the active `piiProtection` settings for a tenant. Returns `null`
   * when the tenant has no stored settings — the service falls back to the
   * disabled default in that case.
   */
  getPiiProtection(tenantId: string): Promise<PiiProtectionSettings | null>;
}

export type PiiSubject =
  | { kind: "chat_prompt" }
  | { kind: "upload" }
  | { kind: "microsoft_import" };

export type PiiDecision =
  | { action: "allow"; reason: "disabled" | "scope_excluded" | "no_findings" }
  | {
      action: "report";
      findings: PiiFinding[];
      providerType: string | null;
      providerModel: string | null;
    }
  | {
      action: "block";
      findings: PiiFinding[];
      blockReason: string;
      providerType: string | null;
      providerModel: string | null;
    }
  | {
      action: "transform";
      transformedText: string;
      findings: PiiFinding[];
      providerType: string | null;
      providerModel: string | null;
    };

export interface PiiServiceEvaluateTextInput {
  tenantId: string;
  text: string;
  subject: PiiSubject;
}

export interface PiiServiceEvaluateArtifactInput {
  tenantId: string;
  artifact: PiiScanArtifactInput;
  subject: PiiSubject;
}

export interface PiiProtectionServiceOptions {
  policyReader: PiiPolicyReader;
  ruleDetector: RuleBasedPiiDetector;
  /**
   * Optional provider. When absent, the service still honors `off` and `detect`
   * (via rule detection only) and fails closed on `block`/`transform` because
   * no provider is available to complete the decision.
   */
  provider?: PiiProvider;
  timeoutMs: number;
  /**
   * Hard cap on artifact bytes read into memory for a scan. Reading beyond
   * this throws `file_too_large` (permanent failure). Defaults to 5 MiB.
   */
  artifactMaxBytes?: number;
  /**
   * CSV preview budget — header + first N data rows or this many bytes,
   * whichever is smaller. Defaults to 10 rows / 4 KB.
   */
  csvPreviewRows?: number;
  csvPreviewMaxBytes?: number;
  /**
   * Required when any tenant uses `rawRetention='reversible_encrypted'`. When
   * absent, that retention mode throws `pii_kek_missing` rather than silently
   * persisting plaintext or stripping to empty string.
   */
  findingEncryptor?: PiiFindingEncryptor;
}

export class PiiProtectionServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PiiProtectionServiceError";
    this.code = code;
  }
}

export class PiiProtectionService {
  constructor(private readonly options: PiiProtectionServiceOptions) {}

  async getActiveSettings(tenantId: string): Promise<PiiProtectionSettings> {
    const record = await this.options.policyReader.getPiiProtection(tenantId);
    return record ?? DEFAULT_PII_PROTECTION;
  }

  async evaluateText(input: PiiServiceEvaluateTextInput): Promise<PiiDecision> {
    const settings = await this.getActiveSettings(input.tenantId);

    if (!isEffectivelyEnabled(settings)) {
      return { action: "allow", reason: "disabled" };
    }

    if (!isScopeEnabled(settings, input.subject)) {
      return { action: "allow", reason: "scope_excluded" };
    }

    const mode: PiiMode = settings.mode;
    if (mode === "off") {
      return { action: "allow", reason: "disabled" };
    }

    const ruleResult = this.options.ruleDetector.detect(input.text, {
      entityTypes: settings.detectors.entityTypes
    });

    if (mode === "detect") {
      const combined = await this.runDetectWithOptionalProvider({
        settings,
        text: input.text,
        ruleFindings: ruleResult.findings
      });
      return this.decideFromCombined(combined, settings, input.tenantId, (sealed) => ({
        action: "report",
        findings: sealed,
        providerType: combined.providerType,
        providerModel: combined.providerModel
      }));
    }

    if (mode === "block") {
      const combined = await this.runDetectWithOptionalProvider({
        settings,
        text: input.text,
        ruleFindings: ruleResult.findings,
        failClosed: true
      });
      return this.decideFromCombined(combined, settings, input.tenantId, (sealed) => ({
        action: "block",
        findings: sealed,
        blockReason: combined.findings[0]?.entityType ?? "unknown",
        providerType: combined.providerType,
        providerModel: combined.providerModel
      }));
    }

    // mode === "transform"
    if (!this.options.provider) {
      throw new PiiProtectionServiceError(
        "pii_provider_unavailable",
        "transform mode requires a configured PII provider"
      );
    }

    const transformResult = await this.callProvider(() =>
      this.options.provider!.transformText(
        {
          text: input.text,
          entityTypes: settings.detectors.entityTypes,
          model: resolveProviderModel(settings)
        },
        undefined
      )
    );

    const mergedFindings = mergeFindings(ruleResult.findings, transformResult.findings);
    if (mergedFindings.length === 0) {
      return { action: "allow", reason: "no_findings" };
    }

    // Belt-and-suspenders: if the provider missed any deterministic match that
    // the rule detector already found, scrub it ourselves before returning. We
    // can't trust the model to always redact the exact spans we anchored.
    const scrubbedText = enforceRuleRedactions(transformResult.transformedText, ruleResult.findings);

    return {
      action: "transform",
      transformedText: scrubbedText,
      findings: this.applyRetentionPolicy(mergedFindings, settings.rawRetention, input.tenantId),
      providerType: transformResult.providerType,
      providerModel: transformResult.providerModel
    };
  }

  async evaluateArtifact(input: PiiServiceEvaluateArtifactInput): Promise<PiiDecision> {
    const settings = await this.getActiveSettings(input.tenantId);

    if (!isEffectivelyEnabled(settings) || !isScopeEnabled(settings, input.subject)) {
      return { action: "allow", reason: !isEffectivelyEnabled(settings) ? "disabled" : "scope_excluded" };
    }

    if (settings.mode === "off") {
      return { action: "allow", reason: "disabled" };
    }

    // Reject binary content types up front — the rule detector and the LLM both
    // produce noise on binary bytes decoded as UTF-8, and we'd waste tokens.
    if (!isScannableContentType(input.artifact.contentType)) {
      throw new PiiProtectionServiceError(
        "unsupported_mime",
        `PII scan does not support content type '${input.artifact.contentType}'`
      );
    }

    // Always run rule-based detection first — it catches obvious PII deterministically
    // and keeps the detect/block policies working even when the provider is disabled.
    const content = await input.artifact.readContent();
    const maxBytes = this.options.artifactMaxBytes ?? 5 * 1024 * 1024;
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new PiiProtectionServiceError(
        "file_too_large",
        `Artifact exceeds the ${maxBytes}-byte PII scan cap`
      );
    }
    const ruleFindings = isCsvContentType(input.artifact.contentType)
      ? this.options.ruleDetector.detectCsv(content, { entityTypes: settings.detectors.entityTypes }).findings
      : this.options.ruleDetector.detect(content, { entityTypes: settings.detectors.entityTypes }).findings;

    let combinedFindings = ruleFindings;
    let providerType: string | null = null;
    let providerModel: string | null = null;

    if (this.options.provider) {
      try {
        const scan = await this.callProvider(() => this.scanWithProvider(input.artifact, content, settings));
        combinedFindings = mergeFindings(ruleFindings, scan.findings);
        providerType = scan.providerType;
        providerModel = scan.providerModel;
      } catch (error) {
        // detect mode keeps working off rule findings during a provider
        // outage; block stays fail-closed.
        if (settings.mode !== "detect" || !isBreakerOpenError(error)) {
          throw error;
        }
      }
    }

    if (combinedFindings.length === 0) {
      return { action: "allow", reason: "no_findings" };
    }

    if (settings.mode === "block") {
      const blockReason = combinedFindings[0]?.entityType ?? "unknown";
      return {
        action: "block",
        findings: this.applyRetentionPolicy(combinedFindings, settings.rawRetention, input.tenantId),
        blockReason,
        providerType,
        providerModel
      };
    }

    // detect and transform (artifact transform deferred to phase 2) both surface as report in phase 1.
    return {
      action: "report",
      findings: this.applyRetentionPolicy(combinedFindings, settings.rawRetention, input.tenantId),
      providerType,
      providerModel
    };
  }

  /**
   * Decides whether a request should be executed synchronously (provider call
   * in the hot path) or asynchronously (enqueue a scan job). Phase 1:
   * - `block` and `transform` are sync (fail-closed within the timeout budget).
   * - `detect` is async for uploads/microsoft, sync for chat prompts so the
   *   scan run id can be attached to the message before the runtime turn begins.
   */
  resolveExecutionPath(settings: PiiProtectionSettings, subject: PiiSubject): "sync" | "async" {
    if (!isEffectivelyEnabled(settings)) return "sync";
    if (settings.mode === "block" || settings.mode === "transform") return "sync";
    if (subject.kind === "chat_prompt") return "sync";
    return "async";
  }

  private async runDetectWithOptionalProvider(args: {
    settings: PiiProtectionSettings;
    text: string;
    ruleFindings: PiiFinding[];
    failClosed?: boolean;
  }): Promise<{
    findings: PiiFinding[];
    providerType: string | null;
    providerModel: string | null;
  }> {
    if (!this.options.provider) {
      if (args.failClosed && args.settings.mode === "block") {
        throw new PiiProtectionServiceError(
          "pii_provider_unavailable",
          "block mode requires a configured PII provider"
        );
      }
      return { findings: args.ruleFindings, providerType: null, providerModel: null };
    }

    let providerResult;
    try {
      providerResult = await this.callProvider(() =>
        this.options.provider!.detectText(
          {
            text: args.text,
            entityTypes: args.settings.detectors.entityTypes,
            model: resolveProviderModel(args.settings)
          },
          undefined
        )
      );
    } catch (error) {
      // In detect mode (failClosed=false), a breaker-open error means the
      // provider is currently unhealthy. Degrade to rules-only findings so
      // detect keeps reporting deterministic PII during outages instead of
      // 503-ing the user. Block / transform stay fail-closed.
      if (!args.failClosed && isBreakerOpenError(error)) {
        return { findings: args.ruleFindings, providerType: null, providerModel: null };
      }
      throw error;
    }

    return {
      findings: mergeFindings(args.ruleFindings, providerResult.findings),
      providerType: providerResult.providerType,
      providerModel: providerResult.providerModel
    };
  }

  /**
   * Picks the right provider call for the artifact. CSV uses the column-aware
   * `scanCsvPreview` (header + first N rows, byte-capped) when the provider
   * supports it — falls back to `scanArtifact` if not. Non-CSV always uses
   * `scanArtifact` over the full content.
   */
  private async scanWithProvider(
    artifact: PiiScanArtifactInput,
    content: string,
    settings: PiiProtectionSettings
  ): Promise<{
    findings: PiiFinding[];
    providerType: string | null;
    providerModel: string | null;
  }> {
    if (isCsvContentType(artifact.contentType) && this.options.provider!.scanCsvPreview) {
      const preview = buildCsvPreview(content, {
        maxRows: this.options.csvPreviewRows ?? 10,
        maxBytes: this.options.csvPreviewMaxBytes ?? 4096
      });
      const result = await this.options.provider!.scanCsvPreview(
        {
          artifactId: artifact.artifactId,
          preview,
          entityTypes: settings.detectors.entityTypes,
          model: resolveProviderModel(settings)
        },
        undefined
      );
      return {
        findings: result.findings,
        providerType: result.providerType,
        providerModel: result.providerModel
      };
    }
    const result = await this.options.provider!.scanArtifact(
      {
        artifactId: artifact.artifactId,
        contentType: artifact.contentType,
        readContent: async () => content,
        entityTypes: settings.detectors.entityTypes,
        model: resolveProviderModel(settings)
      },
      undefined
    );
    return {
      findings: result.findings,
      providerType: result.providerType,
      providerModel: result.providerModel
    };
  }

  private async callProvider<TResult>(run: () => Promise<TResult>): Promise<TResult> {
    try {
      return await run();
    } catch (error) {
      // Surface breaker-open as its own code so callers can distinguish it
      // from a one-off provider blip (and decide whether to degrade or 503).
      const code =
        error instanceof Error && /breaker_open/.test((error as { code?: string }).code ?? "")
          ? "pii_provider_breaker_open"
          : "pii_provider_unavailable";
      throw new PiiProtectionServiceError(
        code,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  // Applies the tenant's `rawRetention` policy to a finding list before the
  // findings cross the service boundary. Decisions returned from the service
  // are what gets persisted to `pii_scan_runs.findings_json`, surfaced in
  // admin reads, and serialized into audit payloads — so transforming `value`
  // here keeps raw PII out of every downstream sink.
  //
  // - `never`: strip `value` entirely.
  // - `admin_only`: keep `value`; admin-only access is enforced by the admin
  //   route which already requires admin role.
  // - `reversible_encrypted`: encrypt `value` with the tenant-scoped DEK.
  //   Throws `pii_kek_missing` if no encryptor is configured — we refuse to
  //   silently downgrade to plaintext or empty under a setting that promises
  //   encryption.
  //
  // Shared finalize step for the detect/block branches in evaluateText:
  // short-circuit on zero findings, otherwise seal the findings under the
  // retention policy and let the caller assemble the final decision.
  // Transform mode doesn't fit this shape (its findings come from a merge
  // step, not directly from `combined`), so it stays inline in evaluateText.
  private decideFromCombined(
    combined: { findings: PiiFinding[] },
    settings: PiiProtectionSettings,
    tenantId: string,
    build: (sealed: PiiFinding[]) => PiiDecision
  ): PiiDecision {
    if (combined.findings.length === 0) {
      return { action: "allow", reason: "no_findings" };
    }
    const sealed = this.applyRetentionPolicy(combined.findings, settings.rawRetention, tenantId);
    return build(sealed);
  }

  private applyRetentionPolicy(
    findings: PiiFinding[],
    retention: PiiProtectionSettings["rawRetention"],
    tenantId: string
  ): PiiFinding[] {
    if (retention === "admin_only") return findings;
    if (retention === "reversible_encrypted") {
      if (!this.options.findingEncryptor) {
        throw new PiiProtectionServiceError(
          "pii_kek_missing",
          "rawRetention='reversible_encrypted' requires PII_RETENTION_KEK to be configured"
        );
      }
      const encryptor = this.options.findingEncryptor;
      return findings.map((finding) => ({
        ...finding,
        value: encryptor.encryptValue(finding.value, tenantId)
      }));
    }
    return findings.map((finding) => ({ ...finding, value: "" }));
  }

  /**
   * Decrypts an encrypted finding value back to plaintext. Intended for
   * admin "reveal" UIs gated by role check at the route layer. Throws
   * `pii_kek_missing` when no encryptor is configured.
   */
  decryptFindingValue(envelope: string, tenantId: string): string {
    if (!this.options.findingEncryptor) {
      throw new PiiProtectionServiceError(
        "pii_kek_missing",
        "decryption requires PII_RETENTION_KEK to be configured"
      );
    }
    return this.options.findingEncryptor.decryptValue(envelope, tenantId);
  }
}

function isBreakerOpenError(error: unknown): boolean {
  return (
    error instanceof PiiProtectionServiceError &&
    error.code === "pii_provider_breaker_open"
  );
}

function isEffectivelyEnabled(settings: PiiProtectionSettings): boolean {
  return settings.enabled && settings.mode !== "off";
}

function isScopeEnabled(settings: PiiProtectionSettings, subject: PiiSubject): boolean {
  switch (subject.kind) {
    case "chat_prompt":
      return settings.scopes.chatPrompts;
    case "upload":
      return settings.scopes.uploads;
    case "microsoft_import":
      return settings.scopes.microsoftImports;
  }
}

/**
 * Build a CSV preview = header row + up to `maxRows` data rows, truncated
 * once cumulative size exceeds `maxBytes`. The header is always included
 * even if it alone exceeds the byte budget — column structure is more
 * valuable to the LLM than any single data row.
 *
 * Splits on \n only (handling \r\n by trimming), so we don't worry about
 * embedded newlines inside quoted CSV cells. The cost of misidentifying
 * a "row" inside a quoted multi-line value is bounded — at worst the
 * preview has slightly different content than expected, never more bytes
 * than the budget.
 */
export function buildCsvPreview(
  content: string,
  options: { maxRows: number; maxBytes: number }
): string {
  const lines = content.split("\n");
  if (lines.length === 0) return "";
  const out: string[] = [];
  let bytes = 0;
  // Always include the header. If even the header is over budget, truncate it.
  const header = (lines[0] ?? "").replace(/\r$/, "");
  out.push(header.length > options.maxBytes ? header.slice(0, options.maxBytes) : header);
  bytes += out[0]!.length + 1; // +1 for the newline join
  for (let i = 1; i < lines.length && out.length <= options.maxRows; i += 1) {
    const row = (lines[i] ?? "").replace(/\r$/, "");
    if (bytes + row.length + 1 > options.maxBytes) break;
    out.push(row);
    bytes += row.length + 1;
  }
  return out.join("\n");
}

function isCsvContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return normalized === "text/csv" || normalized === "application/csv";
}

// Content types we'll attempt to scan as text. Binary formats (PDF, Office,
// images, archives) are rejected with `unsupported_mime` so the job
// terminates instead of producing nonsense findings on garbled UTF-8.
const SCANNABLE_NON_TEXT_TYPES = new Set<string>([
  "application/csv",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml"
]);

function isScannableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!normalized) return false;
  if (normalized.startsWith("text/")) return true;
  return SCANNABLE_NON_TEXT_TYPES.has(normalized);
}

function resolveProviderModel(settings: PiiProtectionSettings): string | undefined {
  const model = settings.provider.model.trim();
  if (!model) return undefined;
  return model;
}

function enforceRuleRedactions(transformedText: string, ruleFindings: PiiFinding[]): string {
  let scrubbed = transformedText;
  for (const finding of ruleFindings) {
    if (!finding.value) continue;
    if (!scrubbed.includes(finding.value)) continue;
    scrubbed = scrubbed.split(finding.value).join(`[REDACTED:${finding.entityType}]`);
  }
  return scrubbed;
}

function mergeFindings(a: PiiFinding[], b: PiiFinding[]): PiiFinding[] {
  const seen = new Set<string>();
  const merged: PiiFinding[] = [];
  for (const finding of [...a, ...b]) {
    const key = `${finding.entityType}:${finding.start}:${finding.end}:${finding.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
}

// Re-export for consumer convenience — a type declared in pii-provider.ts is used here.
export type { PiiScanArtifactInput } from "./pii-provider.js";
