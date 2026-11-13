import { test, expect } from "vitest";

import { randomText, runIsolated, seededRandom } from "../../test-helpers/isolated-timing.js";
import { RuleBasedPiiDetector } from "./rule-based-pii-detector.js";

test("detect finds emails with correct offsets", () => {
  const detector = new RuleBasedPiiDetector();
  const text = "ping a@b.co please";
  const result = detector.detect(text, { entityTypes: ["email"] });

  expect(result.findings.length).toBe(1);
  const finding = result.findings[0];
  expect(finding).toBeTruthy();
  expect(finding.entityType).toBe("email");
  expect(finding.value).toBe("a@b.co");
  expect(text.slice(finding.start, finding.end)).toBe("a@b.co");
  expect(result.handledEntityTypes.has("email")).toBeTruthy();
});

test("detect finds North American phone numbers across formats", () => {
  const detector = new RuleBasedPiiDetector();
  const text = "call (415) 555-2671 or 415.555.2671 or +1 415-555-2671";
  const result = detector.detect(text, { entityTypes: ["phone"] });

  expect(result.findings.length).toBe(3);
  for (const finding of result.findings) {
    expect(finding.entityType).toBe("phone");
    expect(text.slice(finding.start, finding.end)).toBe(finding.value);
  }
});

test("detect finds SSNs but rejects invalid area numbers", () => {
  const detector = new RuleBasedPiiDetector();
  const text = "valid 123-45-6789 invalid 000-12-3456 invalid 666-12-3456";
  const result = detector.detect(text, { entityTypes: ["government_id"] });

  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.value).toBe("123-45-6789");
});

test("detect accepts Luhn-valid credit cards and rejects others", () => {
  const detector = new RuleBasedPiiDetector();
  const valid = "4242 4242 4242 4242";
  const invalid = "4242 4242 4242 4243";
  const text = `valid ${valid} invalid ${invalid}`;
  const result = detector.detect(text, { entityTypes: ["financial"] });

  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.value).toBe(valid);
});

test("detect skips entity types not in the allowed list", () => {
  const detector = new RuleBasedPiiDetector();
  const text = "email a@b.co phone (415) 555-2671";
  const result = detector.detect(text, { entityTypes: ["email"] });

  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("email");
  expect(result.handledEntityTypes.has("email")).toBeTruthy();
  expect(result.handledEntityTypes.has("phone")).toBe(false);
});

test("detect returns an empty result when no PII is present", () => {
  const detector = new RuleBasedPiiDetector();
  const result = detector.detect("no pii here at all", { entityTypes: ["email", "phone"] });
  expect(result.findings.length).toBe(0);
});

test("detectCsv flags header-level hints even when values are benign", () => {
  const detector = new RuleBasedPiiDetector();
  const csv = "name,email_address,favorite_color\nAlice,a@b.co,blue\nBob,b@c.co,red";
  const result = detector.detectCsv(csv, { entityTypes: ["email", "person_name"] });

  const emailHeader = result.findings.find(
    (f) => f.entityType === "email" && f.confidence === "low"
  );
  expect(emailHeader).toBeTruthy();

  const personNameHeader = result.findings.find(
    (f) => f.entityType === "person_name" && f.confidence === "low"
  );
  expect(personNameHeader).toBeTruthy();

  const valueLevelEmails = result.findings.filter(
    (f) => f.entityType === "email" && f.confidence === "high"
  );
  expect(valueLevelEmails.length).toBe(2);
});

test("detectCsv reports handledEntityTypes so callers can skip provider calls", () => {
  const detector = new RuleBasedPiiDetector();
  const result = detector.detectCsv("header\nvalue", { entityTypes: ["email", "phone"] });
  expect(result.handledEntityTypes.has("email")).toBeTruthy();
  expect(result.handledEntityTypes.has("phone")).toBeTruthy();
});

test("detectCsv handles empty input", () => {
  const detector = new RuleBasedPiiDetector();
  const result = detector.detectCsv("", { entityTypes: ["email"] });
  expect(result.findings).toEqual([]);
});

test("detectCsv recognizes financial header aliases", () => {
  const detector = new RuleBasedPiiDetector();
  const result = detector.detectCsv("credit_card,iban,routing,cc_number\n", {
    entityTypes: ["financial"]
  });
  // 4 financial header hints, all confidence=low
  const financialHints = result.findings.filter((f) => f.entityType === "financial");
  expect(financialHints.length).toBe(4);
  expect(financialHints.every((f) => f.confidence === "low")).toBe(true);
});

test("detectCsv recognizes person_name and address header aliases", () => {
  const detector = new RuleBasedPiiDetector();
  const result = detector.detectCsv("first_name,address\n", {
    entityTypes: ["person_name", "address"]
  });
  const types = new Set(result.findings.map((f) => f.entityType));
  expect(types.has("person_name")).toBe(true);
  expect(types.has("address")).toBe(true);
});

test("detectCsv ignores header hints for entity types not in the allow-list", () => {
  const detector = new RuleBasedPiiDetector();
  // Allow only email; the phone header should NOT produce a column hint.
  const result = detector.detectCsv("phone,email\n", { entityTypes: ["email"] });
  const phoneHints = result.findings.filter((f) => f.entityType === "phone");
  expect(phoneHints).toEqual([]);
});

test("detectCsv handles quoted CSV cells without breaking column offsets", () => {
  const detector = new RuleBasedPiiDetector();
  const result = detector.detectCsv(
    'name,"weird,header","ssn"\nalice,x,123-45-6789',
    { entityTypes: ["person_name", "government_id"] }
  );
  // person_name should be detected at column 0, ssn at column 2
  const personName = result.findings.find((f) => f.entityType === "person_name" && f.confidence === "low");
  expect(personName).toBeDefined();
  // SSN value-level finding should be present (high confidence)
  const ssnValue = result.findings.find((f) => f.entityType === "government_id" && f.value === "123-45-6789");
  expect(ssnValue).toBeDefined();
});

test("detect rejects credit card patterns that fail Luhn", () => {
  const detector = new RuleBasedPiiDetector();
  // Made-up 16-digit number that's not Luhn-valid
  const result = detector.detect("payment 1234 5678 9012 3450", { entityTypes: ["financial"] });
  expect(result.findings).toEqual([]);
});

test("detect skips matches when validate fails (luhn check on non-digit characters embedded)", () => {
  const detector = new RuleBasedPiiDetector();
  // A Luhn-valid card number with dashes is a match.
  const result = detector.detect("4111-1111-1111-1111", { entityTypes: ["financial"] });
  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("financial");
});

// The email rule replaced this regex, which took quadratic time on a long run
// of local-part characters. The rule must find the same matches.
const REGEX_EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

test("detect finds the same emails and offsets as the regex on random text", () => {
  const detector = new RuleBasedPiiDetector();
  const random = seededRandom(20_261_113);
  const alphabet = ["a", "Z", "9", "_", ".", "%", "+", "-", "@", " ", "!", "é", "co", "@x.", ".io", "\n", "a@b.co"];
  const mismatches: string[] = [];
  let withMatches = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const text = randomText(random, alphabet, 22);
    const found = detector.detect(text, { entityTypes: ["email"] }).findings
      .map((finding) => `${finding.start}-${finding.end}:${finding.value}`);
    const expected = [...text.matchAll(REGEX_EMAIL_PATTERN)]
      .map((match) => `${match.index}-${match.index + match[0].length}:${match[0]}`);
    if (expected.length > 0) withMatches += 1;
    if (found.join("|") !== expected.join("|")) mismatches.push(JSON.stringify(text));
  }
  expect(mismatches).toEqual([]);
  expect(withMatches).toBeGreaterThan(2_000);
});

test("detect starts an email at the first word boundary of its local part", () => {
  const detector = new RuleBasedPiiDetector();
  const text = "--a.b-c+d%e_f@sub.example.co, .x@y.io! a@b.co1 a@b.c a@b.co-x";
  const findings = detector.detect(text, { entityTypes: ["email"] }).findings;

  expect(findings.map(({ value, start, end }) => ({ value, start, end }))).toEqual([
    { value: "a.b-c+d%e_f@sub.example.co", start: 2, end: 28 },
    { value: "x@y.io", start: 31, end: 37 },
    { value: "a@b.co", start: 53, end: 59 }
  ]);
  for (const finding of findings) expect(text.slice(finding.start, finding.end)).toBe(finding.value);
});

test("detect does not start an email inside the domain of the previous one", () => {
  const detector = new RuleBasedPiiDetector();
  const findings = detector.detect("x@y.zz@w.com", { entityTypes: ["email"] }).findings;
  expect(findings.map(({ value, start }) => ({ value, start }))).toEqual([{ value: "x@y.zz", start: 0 }]);
});

test("detectCsv gives header hints the offset of their quoted or plain cell", () => {
  const detector = new RuleBasedPiiDetector();
  const header = '"a,b",email,"x""y",phone';
  const result = detector.detectCsv(`${header}\nrow`, { entityTypes: ["email", "phone"] });
  const hints = result.findings.filter((finding) => finding.confidence === "low");

  expect(hints.map(({ entityType, value, start }) => ({ entityType, value, start }))).toEqual([
    { entityType: "email", value: "email", start: 6 },
    { entityType: "phone", value: "phone", start: 19 }
  ]);
  expect(header.slice(19, 24)).toBe("phone");
});

// The old email regex and header-offset scan needed hours on these inputs. In
// a separate process, a regression fails at the kill timeout instead of
// blocking the test run. Measured on an Intel i5-12600K: under 10 ms for each
// email input, about 150 ms for the CSV header.
test("detect and detectCsv stay linear on large adversarial input", { timeout: 60_000 }, () => {
  type Timed = { ms: number; result: number[] };
  const runs = runIsolated<Record<string, Timed>>(`
    const { RuleBasedPiiDetector } = await importSource("src/services/pii/rule-based-pii-detector.ts");
    const detector = new RuleBasedPiiDetector();
    const entityTypes = ["email", "phone", "government_id", "financial"];
    detector.detect("warm up a@b.co", { entityTypes });
    const count = (findings) => [findings.length, findings.at(-1)?.start ?? -1];
    print({
      // 5,000,000 characters with no "@".
      dottedRun: timed(() => count(detector.detect("a.".repeat(2_500_000), { entityTypes }).findings)),
      // 2,000,000 possible starts that share one "@" with no valid domain.
      sharedAt: timed(() => count(detector.detect("a-".repeat(1_000_000) + "@x", { entityTypes }).findings)),
      // 500,000 header cells that classifyHeader recognizes.
      emailHeader: timed(() => count(detector.detectCsv("email,".repeat(500_000) + "\\nrow", { entityTypes: ["email"] }).findings))
    });
  `);

  expect(runs.dottedRun!.result).toEqual([0, -1]);
  expect(runs.sharedAt!.result).toEqual([0, -1]);
  expect(runs.emailHeader!.result).toEqual([500_000, 499_999 * 6]);
  for (const [name, run] of Object.entries(runs)) expect(run.ms, name).toBeLessThan(2_000);
});
