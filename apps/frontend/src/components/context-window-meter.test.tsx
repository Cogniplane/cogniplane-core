// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ContextWindowMeter } from "./context-window-meter";
import { formatCostUsd, formatTokenCount } from "./context-window-meter.logic";

afterEach(cleanup);

function meter(usedTokens: number, contextWindow: number, costUsd: number) {
  const { container } = render(<ContextWindowMeter usedTokens={usedTokens} contextWindow={contextWindow} costUsd={costUsd} />);
  return container.firstElementChild as HTMLElement | null;
}

it("renders nothing until there is a token reading or a cost", () => {
  expect(meter(0, 200_000, 0)).toBeNull();
  expect(meter(5_000, 0, 0)).toBeNull();
});

it.each([
  ["the context window is unknown", 5_000, 0],
  ["no turn has used tokens yet", 0, 200_000]
])("shows only the cost when %s", (_case, usedTokens, contextWindow) => {
  const element = meter(usedTokens, contextWindow, 0.42);

  expect(element!.getAttribute("aria-label")).toBe(`${formatCostUsd(0.42)} spent this session`);
  expect(element!.querySelector("svg")).toBeNull();
});

/** Filled share of the ring, read back from the foreground circle's dash offset. */
function ringFill(element: HTMLElement): number {
  const ring = element.querySelectorAll("circle")[1]!;
  const circumference = Number(ring.getAttribute("stroke-dasharray"));
  return 1 - Number(ring.getAttribute("stroke-dashoffset")) / circumference;
}

it("describes the fill, the token counts, and the cost", () => {
  const element = meter(50_000, 200_000, 1.5);

  expect(element!.getAttribute("aria-label")).toBe(
    `Context window 25% full · ${formatTokenCount(50_000)} of ${formatTokenCount(200_000)} tokens · ${formatCostUsd(1.5)} spent`
  );
  expect(ringFill(element!)).toBeCloseTo(0.25);
  expect(meter(50_000, 200_000, 0)!.getAttribute("aria-label")).not.toContain("spent");
});

it.each([
  [149_999, "text-on-surface-faint"],
  [150_000, "text-warning"],
  [179_999, "text-warning"],
  [180_000, "text-danger"]
])("tints %i of 200,000 tokens with %s", (usedTokens, tone) => {
  expect(meter(usedTokens, 200_000, 0)!.className).toContain(tone);
});

it("caps the fill at 100% when usage passes the window", () => {
  const element = meter(250_000, 200_000, 0);

  expect(element!.getAttribute("aria-label")).toMatch(/^Context window 100% full/);
  expect(ringFill(element!)).toBeCloseTo(1);
  expect(element!.className).toContain("text-danger");
});
