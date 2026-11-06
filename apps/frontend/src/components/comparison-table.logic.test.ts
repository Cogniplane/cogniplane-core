import { describe, expect, it } from "vitest";

import { cellDisplay, comparisonCaption, formatCellNumber } from "./comparison-table.logic";

describe("cellDisplay", () => {
  it("shows a value as the model gave it, and a 0, false and \"0\" are values", () => {
    const cells = { text: "  $9/mo\n(billed yearly) ", zero: 0, off: false, on: true, digits: "0" };
    expect(cellDisplay(cells, "text")).toEqual({ kind: "value", text: "$9/mo (billed yearly)" });
    expect(cellDisplay(cells, "zero")).toEqual({ kind: "value", text: "0" });
    expect(cellDisplay(cells, "off")).toEqual({ kind: "value", text: "No" });
    expect(cellDisplay(cells, "on")).toEqual({ kind: "value", text: "Yes" });
    expect(cellDisplay(cells, "digits")).toEqual({ kind: "value", text: "0" });
  });

  it("reports missing data for null, a blank text, and a column that the row leaves out", () => {
    const cells = { empty: null, blank: " \n\t ", hidden: "‮\u0007" };
    expect(cellDisplay(cells, "empty")).toEqual({ kind: "missing" });
    expect(cellDisplay(cells, "blank")).toEqual({ kind: "missing" });
    expect(cellDisplay(cells, "hidden")).toEqual({ kind: "missing" });
    expect(cellDisplay(cells, "absent")).toEqual({ kind: "missing" });
  });

  it("never reads the prototype for an id such as toString or hasOwnProperty", () => {
    for (const id of ["toString", "valueOf", "hasOwnProperty", "constructor", "prototype", "__proto__"]) {
      expect(cellDisplay({}, id), id).toEqual({ kind: "missing" });
    }
    expect(cellDisplay({ toString: "own value" }, "toString")).toEqual({ kind: "value", text: "own value" });
  });
});

describe("formatCellNumber", () => {
  it("adds separators and rounds nothing", () => {
    expect(formatCellNumber(1234567.891)).toBe("1,234,567.891");
    expect(formatCellNumber(-1500)).toBe("-1,500");
    expect(formatCellNumber(0.1)).toBe("0.1");
    expect(formatCellNumber(0.00012345)).toBe("0.00012345");
    expect(formatCellNumber(1e-7)).toBe("0.0000001");
    expect(formatCellNumber(1e15)).toBe("1,000,000,000,000,000");
    expect(formatCellNumber(0.1 + 0.2)).toBe("0.30000000000000004");
  });

  it("shows zero as 0, and negative zero too", () => {
    expect(formatCellNumber(0)).toBe("0");
    expect(formatCellNumber(-0)).toBe("0");
  });
});

describe("comparisonCaption", () => {
  it("uses the title on one line, or a plain caption without it", () => {
    expect(comparisonCaption(" Plan\ncomparison ")).toBe("Plan comparison");
    expect(comparisonCaption(undefined)).toBe("Comparison");
    expect(comparisonCaption("\u0007‮")).toBe("Comparison");
  });
});
