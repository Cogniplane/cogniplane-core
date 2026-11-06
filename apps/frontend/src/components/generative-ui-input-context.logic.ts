// What the composer shows of the generated-view values that the next message
// sends. The input is the preview of DeepAgentsBrowserAgent, which runs the
// same code as the request. This file only turns it into rows to read. It
// never decides what is sent.

import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";

import type { EarlierRecordPreview } from "../lib/agui/deep-agents-browser-agent";

export type InputContextRow = {
  /** The JSON pointer, as words: "/checklist/checked" gives "checklist › checked". */
  label: string;
  /** The value as text. Null when the value is too large to send. */
  value: string | null;
  /** Only the first part of the text is sent. */
  cut: boolean;
};

export type InputContextView = { key: string; name: string; rows: InputContextRow[] };

export type InputContext = {
  views: InputContextView[];
  /** Views left out to stay in the size limit. */
  tooLarge: number;
  /** Views left out because organization policy blocked them. */
  blocked: number;
};

export const NO_INPUT_CONTEXT: InputContext = { views: [], tooLarge: 0, blocked: 0 };

function pathLabel(path: string): string {
  const words = path.split("/").slice(1).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return words.filter((word) => word !== "").join(" › ") || "value";
}

function valueText(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === null) return "None";
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** One row for each value. An object of plain values, such as the `checked`
 *  values of a Checklist, gives one row per key, so each item reads alone. */
function rowsOf(path: string, value: unknown, cut: boolean): InputContextRow[] {
  const label = pathLabel(path);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([, item]) => item === null || typeof item !== "object")) {
      return entries.map(([key, item]) => ({ label: `${label} › ${key}`, value: valueText(item), cut: false }));
    }
  }
  return [{ label, value: valueText(value), cut }];
}

export function inputContextOf(preview: {
  records: readonly EarlierRecordPreview[];
  tooLarge: number;
  blocked: number;
}): InputContext {
  const withValues = preview.records.filter((record) =>
    Object.keys(record.userValues ?? {}).length > 0 || (record.omittedValues?.length ?? 0) > 0);
  const counts = new Map<string, number>();
  const views = withValues.map((record) => {
    const place = record.target === GENERATIVE_UI_PANEL_TARGET ? "side panel" : "chat";
    const number = (counts.get(place) ?? 0) + 1;
    counts.set(place, number);
    const cut = new Set(record.cutValues ?? []);
    const rows = [
      ...Object.entries(record.userValues ?? {}).flatMap(([path, value]) => rowsOf(path, value, cut.has(path))),
      ...(record.omittedValues ?? []).map((path) => ({ label: pathLabel(path), value: null, cut: false }))
    ];
    return { key: record.source, place, number, rows };
  });
  return {
    views: views.map(({ key, place, number, rows }) => ({
      key,
      name: (counts.get(place) ?? 0) > 1 ? `View ${number} in the ${place}` : `View in the ${place}`,
      rows
    })),
    tooLarge: preview.tooLarge,
    blocked: preview.blocked
  };
}

export function inputContextSummary(context: InputContext): string {
  const count = context.views.length;
  const parts = count > 0 ? [`Your entries in ${count} generated ${count === 1 ? "view" : "views"} go with your next message`] : [];
  const left = context.tooLarge + context.blocked;
  if (left > 0) parts.push(`${left} ${left === 1 ? "view is" : "views are"} left out`);
  return parts.join(". ");
}
