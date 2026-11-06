// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { barAxis, GenerativeCarousel, GenerativeChart } from "./generative-ui-defaults";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("generated chart defaults", () => {
  it("includes zero for positive and negative bar lengths, while retaining axis labels", () => {
    expect(barAxis({ data: [{ phase: "Draft", count: 2 }, { phase: "Review", count: 4 }], xKey: "phase" })).toEqual({ min: 0 });
    expect(barAxis({ data: [{ count: -2 }, { count: -4 }], yAxis: { min: -10 } })).toEqual({ min: -10, max: 0 });
    expect(barAxis({ data: [{ count: -2 }, { count: 4 }] })).toEqual({});
  });

  it("uses only plotted series and keeps explicit bounds and non-bar charts unchanged", () => {
    const props = { data: [{ category: 10, count: 2, ignored: -100 }], xKey: "category", series: [{ key: "count" }] };
    expect(barAxis(props)).toEqual({ min: 0 });
    const yAxis = { min: 1, max: 8 };
    expect(barAxis({ ...props, yAxis })).toEqual(yAxis);
    expect(barAxis({ ...props, chartType: "line", yAxis })).toBe(yAxis);
    expect(barAxis({ data: [], yAxis })).toBe(yAxis);
  });

  it("names an empty chart and explains the missing data instead of drawing a blank plot", () => {
    render(<GenerativeChart title="Quarterly totals" data={[]} />);
    expect(screen.getByText("Quarterly totals").tagName).toBe("FIGCAPTION");
    expect(screen.getByText("No chart data to show.")).toBeTruthy();
    expect(document.querySelector("svg, [data-a2ui-chart]")).toBeNull();
  });
});

it("refreshes Carousel arrows after a resize without replacing focused slides", () => {
  vi.useFakeTimers();
  let resized = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const setActiveIndex = vi.fn();
  const { unmount } = render(<GenerativeCarousel {...{ label: "Steps", activeIndex: 0, setActiveIndex }}>
    <button>First step</button><button>Second step</button>
  </GenerativeCarousel>);
  const scroller = screen.getByRole("region", { name: "Steps" });
  let width = 800;
  Object.defineProperties(scroller, { clientWidth: { get: () => width }, scrollWidth: { value: 736 } });
  act(resized);
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  const first = screen.getByRole("button", { name: "First step" });
  first.focus();
  width = 312;
  act(resized);
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(first);
  act(() => vi.advanceTimersByTime(150));
  expect(setActiveIndex).not.toHaveBeenCalled();
  fireEvent.scroll(scroller);
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
