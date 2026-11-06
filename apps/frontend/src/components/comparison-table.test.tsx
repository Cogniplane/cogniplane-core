// @vitest-environment jsdom
import type { ComparisonTableProps } from "@cogniplane/shared-types";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GenerativeComparisonTable } from "./comparison-table";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COLUMNS = [{ id: "basic", label: "Basic" }, { id: "pro", label: "Pro" }, { id: "team", label: "Team" }];
const PROPS: ComparisonTableProps = {
  title: "Plan comparison",
  columns: COLUMNS,
  rows: [
    { id: "price", label: "Price", cells: { basic: "$9/mo", pro: 29, team: null } },
    { id: "sso", label: "Single sign-on", cells: { basic: false, pro: true } },
    { id: "seats", label: "Seats", cells: { basic: 0, pro: 1234567.5, team: "" } }
  ]
};

const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const cellTexts = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent);

describe("GenerativeComparisonTable", () => {
  it("is a native table named by its caption, with scoped headers for columns and rows", () => {
    render(<GenerativeComparisonTable {...PROPS} />);

    const table = screen.getByRole("table", { name: "Plan comparison" });
    expect(table.querySelector("caption")?.textContent).toBe("Plan comparison");
    const columnHeaders = within(table).getAllByRole("columnheader");
    expect(columnHeaders.map((header) => header.textContent)).toEqual(["Criteria", "Basic", "Pro", "Team"]);
    expect(columnHeaders.every((header) => header.getAttribute("scope") === "col")).toBe(true);
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders.map((header) => header.textContent)).toEqual(["Price", "Single sign-on", "Seats"]);
    expect(rowHeaders.every((header) => header.getAttribute("scope") === "row")).toBe(true);
  });

  it("shows each value as given, and says No data for null, a blank text and a column that a row leaves out", () => {
    render(<GenerativeComparisonTable {...PROPS} />);

    const [price, sso, seats] = bodyRows();
    expect(cellTexts(price!)).toEqual(["$9/mo", "29", "No data"]);
    expect(cellTexts(sso!)).toEqual(["No", "Yes", "No data"]);
    // A zero is a value. The blank text is not.
    expect(cellTexts(seats!)).toEqual(["0", "1,234,567.5", "No data"]);
  });

  it("makes no claim of its own: no ranking, no highlight, no value that the model did not give", () => {
    render(<GenerativeComparisonTable {...PROPS} />);

    const text = screen.getByRole("region").textContent ?? "";
    expect(text).not.toMatch(/best|worst|winner|recommended|score|rank|%/i);
    expect(document.querySelectorAll("a, button, input, select, textarea, [onclick], [aria-selected], [aria-sort]")).toHaveLength(0);
  });

  it("scrolls inside a region that a keyboard can reach and that has the caption as its name", () => {
    render(<GenerativeComparisonTable {...PROPS} />);

    const region = screen.getByRole("region", { name: "Plan comparison" });
    expect(region.tabIndex).toBe(0);
    expect(region.className).toContain("overflow-x-auto");
    expect(region.className).toContain("max-w-full");
    expect(region.querySelector("table")).toBe(screen.getByRole("table"));
  });

  it("opts out of the markdown table rules of the app, and keeps its caption in view while the region scrolls", () => {
    render(<GenerativeComparisonTable {...PROPS} />);

    // globals.css styles every table of the chat and the panel, except one with this attribute.
    expect(screen.getByRole("table").hasAttribute("data-app-table")).toBe(true);
    const caption = screen.getByRole("table").querySelector("caption")!;
    expect(caption.firstElementChild!.className).toContain("sticky");
    expect(caption.firstElementChild!.className).toContain("left-0");
    expect(screen.getByRole("region").className).toContain("@container");
  });

  it("falls back to a plain caption without a title", () => {
    render(<GenerativeComparisonTable columns={COLUMNS} rows={PROPS.rows} />);
    expect(screen.getByRole("table", { name: "Comparison" })).toBeTruthy();
  });

  it("keeps long text and long unbroken words inside bounded cells, on one line per header", () => {
    const longText = "Includes the full audit trail, the export of every record, and priority support. ".repeat(3).trim();
    const unbroken = "x".repeat(300);
    render(<GenerativeComparisonTable
      title={"T".repeat(120)}
      columns={[{ id: "a", label: "A".repeat(120) }, { id: "b", label: "B" }]}
      rows={[{ id: "r", label: "R".repeat(120), cells: { a: longText, b: unbroken } }]}
    />);

    const [row] = bodyRows();
    expect(cellTexts(row!)).toEqual([longText, unbroken]);
    // Each cell wraps its text in a box that has a width cap and breaks any word.
    for (const cell of within(row!).getAllByRole("cell")) {
      const box = cell.firstElementChild as HTMLElement;
      expect(box.className).toContain("max-w-64");
      expect(box.className).toContain("[overflow-wrap:anywhere]");
    }
    expect((screen.getByRole("rowheader").firstElementChild as HTMLElement).className).toContain("max-w-40");
  });

  it("renders the 8 columns and 30 rows that the schema allows", () => {
    const columns = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, label: `Option ${index}` }));
    const rows = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, label: `Criterion ${index}`, cells: { c0: index } }));
    render(<GenerativeComparisonTable columns={columns} rows={rows} />);

    expect(bodyRows()).toHaveLength(30);
    expect(within(bodyRows()[29]!).getAllByRole("cell")).toHaveLength(8);
    expect(cellTexts(bodyRows()[29]!)).toEqual(["29", ...Array(7).fill("No data")]);
  });

  it("does not read the prototype for a column id such as toString", () => {
    render(<GenerativeComparisonTable
      columns={[{ id: "toString", label: "Own" }, { id: "valueOf", label: "Other" }]}
      rows={[{ id: "r", label: "Row", cells: { valueOf: "set" } }]}
    />);
    expect(cellTexts(bodyRows()[0]!)).toEqual(["No data", "set"]);
  });

  describe("the note about sideways scrolling", () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      disconnected = false;
      constructor(readonly callback: () => void) { FakeResizeObserver.instances.push(this); }
      observe(element: Element) { this.observed.push(element); }
      unobserve() {}
      disconnect() { this.disconnected = true; }
    }
    const measure = (width: { scroll: number; client: number }) => {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => width.scroll });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width.client });
    };
    afterEach(() => {
      // Remove the instance properties, so that jsdom's own getters apply again.
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
      FakeResizeObserver.instances = [];
    });

    it("shows only while the table is wider than its region, and stops watching on unmount", () => {
      vi.stubGlobal("ResizeObserver", FakeResizeObserver);
      const width = { scroll: 900, client: 360 };
      measure(width);
      const view = render(<GenerativeComparisonTable {...PROPS} />);
      const [observer] = FakeResizeObserver.instances;
      expect(observer!.observed).toEqual([screen.getByRole("region"), screen.getByRole("table")]);
      expect(screen.queryByText("Scroll sideways to see all columns.")).toBeNull();

      act(() => observer!.callback());
      expect(screen.getByText("Scroll sideways to see all columns.")).toBeTruthy();

      width.scroll = 360;
      act(() => observer!.callback());
      expect(screen.queryByText("Scroll sideways to see all columns.")).toBeNull();

      view.unmount();
      expect(observer!.disconnected).toBe(true);
    });

    it("renders without ResizeObserver", () => {
      vi.stubGlobal("ResizeObserver", undefined);
      render(<GenerativeComparisonTable {...PROPS} />);
      expect(screen.getByRole("table")).toBeTruthy();
    });
  });
});
