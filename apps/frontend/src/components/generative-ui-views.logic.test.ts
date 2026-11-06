import type { Message } from "@ag-ui/client";
import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";
import { describe, expect, it } from "vitest";

import {
  boundedTitle, DEFAULT_VIEW_TITLE, effectivePin, MAX_VIEW_TITLE_CHARS, panelActivities, viewLabels, viewTitle,
  type ViewEntry
} from "./generative-ui-views.logic";

const activity = (surfaceId: string, operations: object[] = [{ version: "v1.0" }], target: string = GENERATIVE_UI_PANEL_TARGET): Message =>
  ({
    id: `genui:${surfaceId}`, role: "activity", activityType: "generative-ui-surface",
    content: { surfaceId, target, catalogId: "cogniplane/standard@1", operations, status: "ready", rejected: [] }
  }) as Message;
const user = (id: string): Message => ({ id, role: "user", content: id });
const assistant = (id: string): Message => ({ id, role: "assistant", content: id });

describe("panelActivities", () => {
  it("numbers the replies by their place in the transcript", () => {
    const found = panelActivities([
      user("u0"), assistant("a0"),
      user("u1"), assistant("a1"), activity("turn:a1:one"), { id: "t1", role: "tool", toolCallId: "c", content: "ok" } as Message,
      assistant("a1b"), activity("turn:a1:two"),
      user("u2"), activity("turn:a2:one")
    ]);
    expect(found.map((view) => [view.surfaceId, view.reply])).toEqual([["turn:a1:one", 2], ["turn:a1:two", 2], ["turn:a2:one", 3]]);
  });

  it("counts a reply that comes before any user message, and ignores system messages and other targets", () => {
    const found = panelActivities([
      { id: "s", role: "system", content: "rules" } as Message,
      assistant("a0"), activity("turn:a0:view"),
      user("u1"), { id: "s2", role: "developer", content: "x" } as Message, assistant("a1"), activity("turn:a1:chat", [{ version: "v1.0" }], "chat")
    ]);
    expect(found.map((view) => [view.surfaceId, view.reply])).toEqual([["turn:a0:view", 1]]);
  });

  it("leaves out a withdrawn preview, which has no operations, but still counts its reply", () => {
    const found = panelActivities([user("u0"), activity("turn:a0:gone", []), user("u1"), activity("turn:a1:view")]);
    expect(found.map((view) => [view.surfaceId, view.reply])).toEqual([["turn:a1:view", 2]]);
  });

  it("keeps the place of a surface that appears twice and takes its newest content", () => {
    const first = activity("turn:a1:view", [{ n: 1 }]);
    const second = activity("turn:a1:view", [{ n: 1 }, { n: 2 }]);
    const found = panelActivities([user("u1"), first, activity("turn:a1:other"), user("u2"), second]);
    expect(found.map((view) => [view.surfaceId, view.reply])).toEqual([["turn:a1:view", 1], ["turn:a1:other", 1]]);
    expect(found[0]!.content.operations).toHaveLength(2);
  });

  it("takes no reply from the content of an activity", () => {
    const forged = activity("turn:a99:view");
    (forged as unknown as { content: Record<string, unknown> }).content.reply = 7;
    expect(panelActivities([user("u1"), assistant("a1"), forged])[0]!.reply).toBe(1);
  });
});

describe("boundedTitle", () => {
  it("returns plain text of bounded length", () => {
    expect(boundedTitle("  Release   plan \n for\tQ4 ")).toBe("Release plan for Q4");
    const long = boundedTitle("x".repeat(500))!;
    expect([...long]).toHaveLength(MAX_VIEW_TITLE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("removes control, format and bidirectional characters", () => {
    expect(boundedTitle("A\u0000B‮C​D⁦E")).toBe("A B C D E");
    expect(boundedTitle("‮​")).toBeUndefined();
  });

  it("cuts by characters, not by code units", () => {
    const text = boundedTitle("😀".repeat(200))!;
    expect([...text]).toHaveLength(MAX_VIEW_TITLE_CHARS);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("gives no title for a value that is not text", () => {
    for (const value of [undefined, null, 4, true, { "@path": "/title" }, ["x"], "", "   "]) expect(boundedTitle(value)).toBeUndefined();
  });

  it("keeps markup and links as the text that they are", () => {
    expect(boundedTitle("<b>Plan</b> [link](https://example.test)")).toBe("<b>Plan</b> [link](https://example.test)");
  });
});

describe("viewTitle", () => {
  it("takes a literal title of a root that names its view", () => {
    for (const type of ["Checklist", "ComparisonTable", "StatusSummary"]) {
      expect(viewTitle({ type, properties: { title: "Launch plan" } })).toBe("Launch plan");
    }
  });

  it("does not guess: a bound title, another root, or no root gives the default", () => {
    expect(viewTitle({ type: "Checklist", properties: { title: { "@path": "/title" } } })).toBe(DEFAULT_VIEW_TITLE);
    expect(viewTitle({ type: "Checklist", properties: {} })).toBe(DEFAULT_VIEW_TITLE);
    expect(viewTitle({ type: "Column", properties: { title: "Not a title" } })).toBe(DEFAULT_VIEW_TITLE);
    expect(viewTitle({ type: "LinkCard", properties: { title: "A link" } })).toBe(DEFAULT_VIEW_TITLE);
    expect(viewTitle(undefined)).toBe(DEFAULT_VIEW_TITLE);
  });
});

describe("viewLabels", () => {
  const entry = (surfaceId: string, reply: number, title: string, status: ViewEntry["status"] = "ready"): ViewEntry =>
    ({ surfaceId, reply, title, status });
  const labelsOf = (views: ViewEntry[], numbers: boolean) => views.map((view) => viewLabels(views, numbers).get(view.surfaceId));

  it("starts with the reply number and marks the latest view", () => {
    expect(labelsOf([entry("a", 2, "Plan"), entry("b", 3, "Checklist")], true)).toEqual(["Reply 2 · Plan", "Reply 3 · Checklist (latest)"]);
  });

  it("tells views that share a title apart by their reply", () => {
    const labels = labelsOf([entry("a", 2, "Plan"), entry("b", 5, "Plan")], true);
    expect(labels).toEqual(["Reply 2 · Plan", "Reply 5 · Plan (latest)"]);
    expect(new Set(labels).size).toBe(2);
  });

  it("numbers views that share a title and a reply", () => {
    expect(labelsOf([entry("a", 2, "Plan"), entry("b", 2, "Plan"), entry("c", 3, "Other")], true))
      .toEqual(["Reply 2 · Plan (1 of 2)", "Reply 2 · Plan (2 of 2)", "Reply 3 · Other (latest)"]);
  });

  it("numbers only the duplicates when reply numbers are not true", () => {
    expect(labelsOf([entry("a", 2, "Plan"), entry("b", 3, "Plan"), entry("c", 4, "Other")], false))
      .toEqual(["Plan (1 of 2)", "Plan (2 of 2)", "Other (latest)"]);
  });

  it("says when a view is being written or could not be shown", () => {
    expect(labelsOf([entry("a", 2, "Plan", "failed"), entry("b", 3, "Checklist", "streaming")], true))
      .toEqual(["Reply 2 · Plan (could not be shown)", "Reply 3 · Checklist (latest) (being written)"]);
  });
});

describe("effectivePin", () => {
  it("keeps a chosen earlier view that is still there", () => {
    expect(effectivePin(["a", "b", "c"], "a")).toBe("a");
  });

  it("ends the choice for the latest view, a missing view, or no choice", () => {
    expect(effectivePin(["a", "b", "c"], "c")).toBeUndefined();
    expect(effectivePin(["a", "b", "c"], "gone")).toBeUndefined();
    expect(effectivePin(["a", "b", "c"], undefined)).toBeUndefined();
    expect(effectivePin([], "a")).toBeUndefined();
  });
});
