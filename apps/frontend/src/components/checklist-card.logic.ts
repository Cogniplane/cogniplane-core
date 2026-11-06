// Pure rules of the Checklist component of generated UI (checklist-card.tsx).
// The props schema (ChecklistPropsSchema) has already checked the items and
// the values, so these functions only read them.

import type { ChecklistProps } from "@cogniplane/shared-types";

export type ChecklistItem = ChecklistProps["items"][number];

/** A model text for one line: no control or format characters, and no line
 *  breaks, so a label cannot add lines to the draft or hide text. */
export function cleanLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** The value of every item: true or false. An item that `checked` does not
 *  name is false. */
export function completeChecked(items: readonly ChecklistItem[], checked: Readonly<Record<string, boolean>> | undefined): Record<string, boolean> {
  return Object.fromEntries(items.map((item) => [item.id, checked?.[item.id] === true]));
}

export function checkedCount(values: Readonly<Record<string, boolean>>): number {
  return Object.values(values).filter(Boolean).length;
}

/** "2 of 5 done". */
export function progressLabel(done: number, total: number): string {
  return `${done} of ${total} done`;
}

/**
 * The text that "Use in reply" puts in the message box: the title, the
 * progress, every item with its value, checked or not, and the notes when
 * the checklist has a notes field. It states the values. It asks nothing.
 */
export function checklistReplyText(input: {
  title: string | undefined;
  items: readonly ChecklistItem[];
  checked: Readonly<Record<string, boolean>>;
  notes: string | undefined;
}): string {
  const values = completeChecked(input.items, input.checked);
  const title = input.title ? cleanLine(input.title) : "";
  const lines = [
    title ? `Checklist: ${title}` : "Checklist",
    `${checkedCount(values)} of ${input.items.length} checked`,
    "",
    ...input.items.map((item) => `- [${values[item.id] ? "x" : " "}] ${cleanLine(item.label)}`)
  ];
  if (input.notes !== undefined) {
    const notes = input.notes.trim();
    lines.push("", notes === "" ? "Notes: none" : `Notes:\n${notes}`);
  }
  return lines.join("\n");
}

/** Names the checklist in the notice of the message box. */
export function checklistSourceLabel(title: string | undefined): string {
  const clean = title ? cleanLine(title) : "";
  return clean ? `Checklist "${clean}"` : "Checklist";
}
