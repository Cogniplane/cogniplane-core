import type { PiiEntityType } from "./pii-policy.js";
import type { PiiFinding } from "./pii-provider.js";

interface RuleDefinition {
  entityType: PiiEntityType;
  pattern: RegExp;
  confidence: "low" | "medium" | "high";
  validate?: (match: string) => boolean;
}

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// North American + international phone numbers. Accepts optional country code, separators, and extensions.
const PHONE_PATTERN =
  /(?:(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4})\b/g;
// US SSN: 3-2-4 digits. Excludes 000, 666, 9xx area numbers per SSA.
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
// Credit card: 13-19 digits separated by spaces or dashes, Luhn-validated below.
const CREDIT_CARD_PATTERN = /\b(?:\d[\s-]?){12,18}\d\b/g;

const RULES: RuleDefinition[] = [
  { entityType: "email", pattern: EMAIL_PATTERN, confidence: "high" },
  { entityType: "phone", pattern: PHONE_PATTERN, confidence: "medium" },
  { entityType: "government_id", pattern: SSN_PATTERN, confidence: "high" },
  {
    entityType: "financial",
    pattern: CREDIT_CARD_PATTERN,
    confidence: "high",
    validate: (match) => luhnCheck(match.replace(/[\s-]/g, ""))
  }
];

export interface RuleBasedDetectionResult {
  findings: PiiFinding[];
  /**
   * Entity types that this rule detector claims to handle deterministically.
   * Callers can subtract this set from the provider call to save tokens.
   */
  handledEntityTypes: Set<PiiEntityType>;
}

export interface RuleBasedDetectOptions {
  entityTypes: PiiEntityType[];
}

export class RuleBasedPiiDetector {
  detect(text: string, options: RuleBasedDetectOptions): RuleBasedDetectionResult {
    const allowed = new Set<PiiEntityType>(options.entityTypes);
    const findings: PiiFinding[] = [];
    const handled = new Set<PiiEntityType>();

    for (const rule of RULES) {
      if (!allowed.has(rule.entityType)) continue;
      handled.add(rule.entityType);

      for (const match of text.matchAll(rule.pattern)) {
        const value = match[0];
        const start = match.index ?? 0;
        if (rule.validate && !rule.validate(value)) continue;
        findings.push({
          entityType: rule.entityType,
          value,
          start,
          end: start + value.length,
          confidence: rule.confidence
        });
      }
    }

    return { findings, handledEntityTypes: handled };
  }

  /**
   * Detect column-level PII hints for a CSV. Only a small header+sample heuristic —
   * per plan phase 1, CSV is rules-only and we avoid provider fallback for tabular files.
   */
  detectCsv(csvText: string, options: RuleBasedDetectOptions): RuleBasedDetectionResult {
    const allowed = new Set<PiiEntityType>(options.entityTypes);
    const findings: PiiFinding[] = [];
    const handled = new Set<PiiEntityType>(RULES.map((r) => r.entityType).filter((t) => allowed.has(t)));

    const lines = csvText.split(/\r?\n/);
    if (lines.length === 0) return { findings, handledEntityTypes: handled };

    const headerLine = lines[0] ?? "";
    const headers = splitCsvRow(headerLine);
    const headerHints = headers.map((h) => classifyHeader(h));

    // Always run the default text rules over the full CSV body — they handle literal PII in cells.
    const textResult = this.detect(csvText, options);
    findings.push(...textResult.findings);

    // Surface header-level hints so the caller can flag entire columns even when values look benign.
    headerHints.forEach((hint, columnIndex) => {
      if (!hint || !allowed.has(hint)) return;
      const columnOffset = csvColumnHeaderOffset(headerLine, columnIndex);
      if (columnOffset < 0) return;
      findings.push({
        entityType: hint,
        value: headers[columnIndex] ?? "",
        start: columnOffset,
        end: columnOffset + (headers[columnIndex]?.length ?? 0),
        confidence: "low"
      });
    });

    return { findings, handledEntityTypes: handled };
  }
}

function luhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits.charCodeAt(i) - 48;
    if (ch < 0 || ch > 9) return false;
    const value = double ? (ch * 2 > 9 ? ch * 2 - 9 : ch * 2) : ch;
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function csvColumnHeaderOffset(headerLine: string, columnIndex: number): number {
  let offset = 0;
  let column = 0;
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (inQuotes) {
      if (ch === '"' && headerLine[i + 1] === '"') i++;
      else if (ch === '"') inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      if (column === columnIndex) return offset;
      column++;
      offset = i + 1;
    }
  }
  return column === columnIndex ? offset : -1;
}

function classifyHeader(raw: string): PiiEntityType | null {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!normalized) return null;
  if (/(^|_)email(_|$)|e_mail/.test(normalized)) return "email";
  if (/(^|_)(phone|mobile|cell|telephone|tel)(_|$)/.test(normalized)) return "phone";
  if (/(^|_)(ssn|social_security|nas|sin)(_|$)/.test(normalized)) return "government_id";
  if (/(^|_)(address|street|zip|postal|postcode)(_|$)/.test(normalized)) return "address";
  if (/(^|_)(first_name|last_name|full_name|given_name|surname|name)(_|$)/.test(normalized)) {
    return "person_name";
  }
  if (/(^|_)(credit_card|card_number|cc_number|iban|routing|account_number)(_|$)/.test(normalized)) {
    return "financial";
  }
  return null;
}
