// @vitest-environment jsdom
import type { StatusSummaryProps } from "@cogniplane/shared-types";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GenerativeStatusSummary } from "./status-summary";

afterEach(cleanup);

const PROPS: StatusSummaryProps = {
  title: "Release 4.2",
  completed: 5,
  total: 12,
  items: [
    { id: "design", label: "Design", status: "complete", detail: "Signed off by Ada", completed: 4, total: 4 },
    { id: "build", label: "Build", status: "in-progress", detail: "Waiting on the API team", completed: 1, total: 8 },
    { id: "qa", label: "QA", status: "at-risk" },
    { id: "legal", label: "Legal review", status: "blocked", detail: "Contract not signed" },
    { id: "launch", label: "Launch", status: "not-started", completed: 0, total: 0 },
    { id: "docs", label: "Documentation" }
  ]
};

const rows = () => within(screen.getByRole("list")).getAllByRole("listitem");
const progressOf = (row: HTMLElement) => within(row).queryByRole("progressbar") as HTMLProgressElement | null;

describe("GenerativeStatusSummary", () => {
  it("is a section named by its heading, with one row for each item", () => {
    render(<GenerativeStatusSummary {...PROPS} />);

    const section = screen.getByRole("region", { name: "Release 4.2" });
    expect(within(section).getByRole("heading", { level: 3 }).textContent).toBe("Release 4.2");
    expect(rows().map((row) => row.querySelector("span[id]")?.textContent))
      .toEqual(["Design", "Build", "QA", "Legal review", "Launch", "Documentation"]);
  });

  it("states every status as text, and says when a row has none", () => {
    render(<GenerativeStatusSummary {...PROPS} />);

    expect(rows().map((row) => /Status: (.*?)(?:Signed|Waiting|Contract|\d|$)/.exec(row.textContent ?? "")?.[1]?.trim()))
      .toEqual(["Complete", "In progress", "At risk", "Blocked", "Not started", "Status not reported"]);
    // The status never depends on a word of the label or the detail.
    render(<GenerativeStatusSummary items={[{ id: "a", label: "Done and shipped, all green", detail: "Complete, success" }]} />);
    expect(screen.getAllByRole("listitem").at(-1)!.textContent).toContain("Status not reported");
  });

  it("uses the semantic color of each status, and an icon and the text, never color alone", () => {
    render(<GenerativeStatusSummary {...PROPS} />);

    // The chip sits on a clear surface, so a translucent tint keeps the contrast of its text.
    const chip = (row: HTMLElement) => row.querySelector("span.bg-surface-container-lowest > span.rounded")!;
    expect(rows().map((row) => /(bg-\S+) (text-\S+)/.exec(chip(row).className)?.slice(1).join(" "))).toEqual([
      "bg-success-surface text-success",
      "bg-info-surface text-info",
      "bg-warning-surface text-warning",
      "bg-danger-surface text-danger",
      "bg-surface-container text-on-surface-variant",
      "bg-surface-container text-on-surface-variant"
    ]);
    for (const row of rows()) {
      expect(chip(row).querySelector("svg[aria-hidden='true']")).toBeTruthy();
      expect(chip(row).textContent).toMatch(/\S/);
    }
  });

  it("shows a progress control only for counts with a total above zero, and states the counts as text", () => {
    render(<GenerativeStatusSummary {...PROPS} />);

    // The view and two rows.
    const bars = screen.getAllByRole("progressbar") as HTMLProgressElement[];
    expect(bars.map((bar) => [bar.value, bar.max])).toEqual([[5, 12], [4, 4], [1, 8]]);
    expect(screen.getByText("5 of 12 completed")).toBeTruthy();
    const [design, build, qa, legal, launch, docs] = rows();
    expect(progressOf(design!)?.max).toBe(4);
    expect(progressOf(build!)?.value).toBe(1);
    // No counts, no bar. A total of 0 gives the text and no bar.
    for (const row of [qa!, legal!, docs!]) expect(progressOf(row)).toBeNull();
    expect(progressOf(launch!)).toBeNull();
    expect(within(launch!).getByText("0 of 0 completed")).toBeTruthy();
    // The bar is named by its owner, and its value text is the count, never a percentage.
    expect(bars[2]!.getAttribute("aria-valuetext")).toBe("1 of 8 completed");
    expect(bars[2]!.getAttribute("aria-labelledby")).toBe(build!.querySelector("span[id]")!.id);
    expect(bars[0]!.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading").id);
    expect(document.body.textContent).not.toContain("%");
  });

  it("shows the counts of the view without a bar when the total is 0", () => {
    render(<GenerativeStatusSummary completed={0} total={0} items={[]} />);

    expect(screen.getByText("0 of 0 completed")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows a clear empty state, with a plain heading without a title", () => {
    render(<GenerativeStatusSummary items={[]} />);

    expect(screen.getByRole("heading", { name: "Status summary" })).toBeTruthy();
    expect(screen.getByText("No status items to show.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("wraps long text, and holds the 30 rows that the schema allows", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `i${index}`, label: `${index} ${"L".repeat(120)}`.slice(0, 120), status: "in-progress" as const,
      detail: "D".repeat(300), completed: index, total: 30
    }));
    render(<GenerativeStatusSummary title={"T".repeat(120)} items={items} />);

    expect(rows()).toHaveLength(30);
    expect(screen.getByRole("heading").className).toContain("[overflow-wrap:anywhere]");
    expect(rows()[0]!.querySelector("p")!.className).toContain("[overflow-wrap:anywhere]");
    expect(rows()[0]!.querySelector("span[id]")!.className).toContain("min-w-0");
  });

  it("has no link, button or input", () => {
    render(<GenerativeStatusSummary {...PROPS} />);
    expect(document.querySelectorAll("a, button, input, select, textarea, [onclick]")).toHaveLength(0);
  });
});
