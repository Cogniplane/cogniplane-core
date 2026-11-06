// Pure rules of the ComparisonTable component of generated UI
// (comparison-table.tsx). The props schema (ComparisonTablePropsSchema) has
// already checked the ids, the keys and the bounds, so these functions only
// read them and invent nothing.

import type { ComparisonTableProps } from "@cogniplane/shared-types";

import { cleanLine } from "./checklist-card.logic";

export type ComparisonCell = ComparisonTableProps["rows"][number]["cells"][string];

/** What a cell shows when the model gave no value for it. */
export const NO_DATA_LABEL = "No data";

/** The caption when the model sets no title. */
export const DEFAULT_CAPTION = "Comparison";

export function comparisonCaption(title: string | undefined): string {
  return (title ? cleanLine(title) : "") || DEFAULT_CAPTION;
}

/** A number as the model gave it: thousands separators, no rounding. */
export function formatCellNumber(value: number): string {
  // -0 would print as "-0".
  return (Object.is(value, -0) ? 0 : value).toLocaleString("en-US", { maximumSignificantDigits: 17 });
}

export type CellDisplay = { kind: "value"; text: string } | { kind: "missing" };

const MISSING: CellDisplay = { kind: "missing" };

/**
 * What the table shows for one column of a row. A column that the row does not
 * name, null, and a text with nothing in it are all missing data. A 0, false,
 * and "0" are values. The check is an own-key check: an id such as "toString"
 * is a valid id, and a row that leaves it out must not read the prototype.
 */
export function cellDisplay(cells: Readonly<Record<string, ComparisonCell>>, columnId: string): CellDisplay {
  if (!Object.hasOwn(cells, columnId)) return MISSING;
  const value = cells[columnId];
  if (typeof value === "string") {
    const text = cleanLine(value);
    return text === "" ? MISSING : { kind: "value", text };
  }
  if (typeof value === "number") return { kind: "value", text: formatCellNumber(value) };
  if (typeof value === "boolean") return { kind: "value", text: value ? "Yes" : "No" };
  return MISSING;
}
