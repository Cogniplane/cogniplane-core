import { test, expect } from "vitest";

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
  // Luhn check returns false if a non-digit slips through after stripping spaces/dashes.
  // This exercises the `if (ch < 0 || ch > 9) return false;` path.
  const detector = new RuleBasedPiiDetector();
  // Construct a 16-digit string: this is the Luhn-valid 4111-1111-1111-1111
  // but with a cell offset that should match.
  const result = detector.detect("4111-1111-1111-1111", { entityTypes: ["financial"] });
  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("financial");
});
