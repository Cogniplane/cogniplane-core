import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";
import { describe, expect, it } from "vitest";

import { inputContextOf, inputContextSummary, NO_INPUT_CONTEXT } from "./generative-ui-input-context.logic";

describe("inputContextOf", () => {
  it("lists the views with user values, one row per checklist item, false and empty text included", () => {
    const context = inputContextOf({
      records: [
        { source: "turn:a1:list", target: GENERATIVE_UI_PANEL_TARGET,
          userValues: { "/release/checked": { tests: true, rollback: false }, "/release/notes": "" } },
        { source: "turn:a1:poll", target: "chat" },
        { source: "turn:a2:form", target: "chat", userValues: { "/a~1b": "long" }, cutValues: ["/a~1b"], omittedValues: ["/table"] }
      ],
      tooLarge: 0,
      blocked: 0
    });

    expect(context.views).toEqual([
      { key: "turn:a1:list", name: "View in the side panel", rows: [
        { label: "release › checked › tests", value: "Yes", cut: false },
        { label: "release › checked › rollback", value: "No", cut: false },
        { label: "release › notes", value: "Empty", cut: false }
      ] },
      { key: "turn:a2:form", name: "View in the chat", rows: [
        { label: "a/b", value: "long", cut: true },
        { label: "table", value: null, cut: false }
      ] }
    ]);
    expect(inputContextSummary(context)).toBe("Your entries in 2 generated views go with your next message");
  });

  it("numbers views of the same place, and says when views are left out", () => {
    const record = (source: string) => ({ source, target: "chat", userValues: { "/x": 1 } });
    const context = inputContextOf({ records: [record("one"), record("two")], tooLarge: 1, blocked: 1 });
    expect(context.views.map((view) => view.name)).toEqual(["View 1 in the chat", "View 2 in the chat"]);
    expect(inputContextSummary(context)).toBe("Your entries in 2 generated views go with your next message. 2 views are left out");
    expect(inputContextSummary(inputContextOf({ records: [], tooLarge: 0, blocked: 1 }))).toBe("1 view is left out");
    expect(inputContextSummary(NO_INPUT_CONTEXT)).toBe("");
  });
});
