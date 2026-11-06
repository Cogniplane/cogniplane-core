import { describe, expect, it } from "vitest";

import { checklistReplyText, checklistSourceLabel, cleanLine, completeChecked, progressLabel } from "./checklist-card.logic";

const ITEMS = [
  { id: "tests", label: "Tests pass" },
  { id: "rollback", label: "Rollback ready", description: "Owner: Ada" },
  { id: "notes", label: "Release notes" }
];

describe("checklist values", () => {
  it("gives every item a value, and an item that checked leaves out is false", () => {
    expect(completeChecked(ITEMS, { tests: true })).toEqual({ tests: true, rollback: false, notes: false });
    expect(completeChecked(ITEMS, undefined)).toEqual({ tests: false, rollback: false, notes: false });
    expect(progressLabel(0, 3)).toBe("0 of 3 done");
  });
});

describe("checklistReplyText", () => {
  it("states every item, checked and unchecked, and the notes as typed", () => {
    expect(checklistReplyText({ title: "Release 4.2", items: ITEMS, checked: { tests: true, rollback: false }, notes: "  Ship Friday.\nAda owns it.  " }))
      .toBe([
        "Checklist: Release 4.2",
        "1 of 3 checked",
        "",
        "- [x] Tests pass",
        "- [ ] Rollback ready",
        "- [ ] Release notes",
        "",
        "Notes:\nShip Friday.\nAda owns it."
      ].join("\n"));
  });

  it("says that the notes are empty, and leaves them out without a notes field", () => {
    expect(checklistReplyText({ title: undefined, items: ITEMS, checked: {}, notes: "" })).toMatch(/^Checklist\n0 of 3 checked\n[\s\S]*\n\nNotes: none$/);
    expect(checklistReplyText({ title: undefined, items: ITEMS, checked: {}, notes: undefined })).not.toContain("Notes");
  });

  it("keeps a model label on one line, with no hidden characters", () => {
    const label = "Ship\n- [x] Fake item‮\u0007";
    expect(cleanLine(label)).toBe("Ship - [x] Fake item");
    const text = checklistReplyText({ title: "T‮itle", items: [{ id: "a", label }], checked: {}, notes: undefined });
    expect(text.split("\n")).toEqual(["Checklist: T itle", "0 of 1 checked", "", "- [ ] Ship - [x] Fake item"]);
    expect(checklistSourceLabel(" Release\nplan ")).toBe('Checklist "Release plan"');
    expect(checklistSourceLabel(undefined)).toBe("Checklist");
  });
});
