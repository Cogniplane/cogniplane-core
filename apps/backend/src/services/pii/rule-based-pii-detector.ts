import type { PiiEntityType } from "@cogniplane/shared-types";
import type { PiiFinding } from "./pii-provider.js";

interface RuleMatch {
  value: string;
  index: number;
}

interface RuleDefinition {
  entityType: PiiEntityType;
  /** The matches in text order, as `matchAll` of a global regex gives them. */
  matches: (text: string) => Iterable<RuleMatch>;
  confidence: "low" | "medium" | "high";
  validate?: (match: string) => boolean;
}

function* regexMatches(text: string, pattern: RegExp): Generator<RuleMatch> {
  for (const match of text.matchAll(pattern)) yield { value: match[0], index: match.index };
}

// emailMatches finds the matches of
// /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g in linear time. With
// matchAll, that regex tried each start in a long run of local-part characters
// and read the run to its end each time: quadratic time on "a.".repeat(n) with
// no "@". emailMatches reads the text before each "@" once. As with the regex,
// a match starts at the first word boundary in the run of local-part characters
// before the "@", and the sticky regex below matches the domain.
const EMAIL_DOMAIN_AT = /[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/y;

const isWordCode = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
// [A-Za-z0-9._%+-]
const isEmailLocalCode = (code: number) =>
  isWordCode(code) || code === 46 || code === 37 || code === 43 || code === 45;
const isWordBoundary = (text: string, index: number) =>
  isWordCode(text.charCodeAt(index - 1)) !== isWordCode(text.charCodeAt(index));

function* emailMatches(text: string): Generator<RuleMatch> {
  // The regex does not start a match before the end of the previous match.
  let previousEnd = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > previousEnd && isEmailLocalCode(text.charCodeAt(start - 1))) start -= 1;
    while (start < at && !isWordBoundary(text, start)) start += 1;
    if (start === at) continue;
    EMAIL_DOMAIN_AT.lastIndex = at + 1;
    if (!EMAIL_DOMAIN_AT.exec(text)) continue;
    previousEnd = EMAIL_DOMAIN_AT.lastIndex;
    yield { value: text.slice(start, previousEnd), index: start };
  }
}

// Phone numbers. Accepts an optional country code and common separators.
const PHONE_PATTERN =
  /(?:(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4})\b/g;
// US SSN: 3-2-4 digits. Excludes 000, 666, 9xx area numbers per SSA.
const SSN_PATTERN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
// Credit card: 13-19 digits separated by spaces or dashes, Luhn-validated below.
const CREDIT_CARD_PATTERN = /\b(?:\d[\s-]?){12,18}\d\b/g;

const RULES: RuleDefinition[] = [
  { entityType: "email", matches: emailMatches, confidence: "high" },
  { entityType: "phone", matches: (text) => regexMatches(text, PHONE_PATTERN), confidence: "medium" },
  { entityType: "government_id", matches: (text) => regexMatches(text, SSN_PATTERN), confidence: "high" },
  {
    entityType: "financial",
    matches: (text) => regexMatches(text, CREDIT_CARD_PATTERN),
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

      for (const { value, index: start } of rule.matches(text)) {
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
   * Detect column-level PII hints for a CSV. This is a small header and sample
   * heuristic. CSV is rules-only, so tabular files do not fall back to the provider.
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
    const columnOffsets = csvColumnHeaderOffsets(headerLine);
    headerHints.forEach((hint, columnIndex) => {
      if (!hint || !allowed.has(hint)) return;
      const columnOffset = columnOffsets[columnIndex] ?? -1;
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

// The start offset of each header cell, in one pass. A scan from the start of
// the line for each column took quadratic time on a header with many columns
// that classifyHeader recognizes ("email,".repeat(n)).
function csvColumnHeaderOffsets(headerLine: string): number[] {
  const offsets = [0];
  let inQuotes = false;
  for (let i = 0; i < headerLine.length; i++) {
    const ch = headerLine[i];
    if (inQuotes) {
      if (ch === '"' && headerLine[i + 1] === '"') i++;
      else if (ch === '"') inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      offsets.push(i + 1);
    }
  }
  return offsets;
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
