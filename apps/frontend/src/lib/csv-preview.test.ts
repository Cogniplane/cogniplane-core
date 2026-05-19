import { test, expect } from "vitest";

import { parseCsvPreview } from "./csv-preview.js";

test("parseCsvPreview handles basic CSV", () => {
  const csv = "a,b,c\n1,2,3\n4,5,6\n";
  const result = parseCsvPreview(csv);
  expect(result.header).toEqual(["a", "b", "c"]);
  expect(result.rows).toEqual([["1", "2", "3"], ["4", "5", "6"]]);
  expect(result.totalRowsSeen).toBe(2);
  expect(result.truncated).toBe(false);
});

test("parseCsvPreview handles quoted fields with embedded commas and newlines", () => {
  const csv = 'name,note\n"Smith, John","hello\nworld"\n"O\'Brien","x,y"\n';
  const result = parseCsvPreview(csv);
  expect(result.header).toEqual(["name", "note"]);
  expect(result.rows).toEqual([
        ["Smith, John", "hello\nworld"],
        ["O'Brien", "x,y"]
      ]);
});

test("parseCsvPreview handles escaped quotes", () => {
  const csv = 'a\n"she said ""hi"""\n';
  const result = parseCsvPreview(csv);
  expect(result.rows).toEqual([['she said "hi"']]);
});

test("parseCsvPreview truncates at maxRows and reports totals", () => {
  const lines = ["h1,h2"];
  for (let i = 0; i < 250; i++) lines.push(`${i},x`);
  const csv = lines.join("\n") + "\n";
  const result = parseCsvPreview(csv, { maxRows: 100 });
  expect(result.rows.length).toBe(100);
  expect(result.truncated).toBe(true);
  expect(result.totalRowsSeen).toBe(250);
});

test("parseCsvPreview handles files without trailing newline", () => {
  const result = parseCsvPreview("a,b\n1,2");
  expect(result.rows).toEqual([["1", "2"]]);
  expect(result.totalRowsSeen).toBe(1);
});

test("parseCsvPreview tolerates CRLF line endings", () => {
  const result = parseCsvPreview("a,b\r\n1,2\r\n3,4\r\n");
  expect(result.rows).toEqual([["1", "2"], ["3", "4"]]);
});
