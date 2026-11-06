import { describe, expect, it } from "vitest";

import { API_URL } from "../lib/api-client";
import {
  safePaint,
  safePaintProps,
  externalHost,
  formatCoordinate,
  formatRating,
  gridColumns,
  hostInitial,
  hostLabel,
  opensExternally,
  safeLinkHref
} from "./generative-ui-catalog.logic";

describe("safeLinkHref", () => {
  it.each([
    "https://example.com/a?b=1",
    "http://example.com",
    "//example.com/path",
    "/sessions/1",
    "#top",
    `${API_URL}/artifacts/a-1/download`
  ])("keeps %s as a link", (href) => {
    expect(safeLinkHref(href)).toBe(href);
  });

  it.each([
    undefined,
    "",
    "javascript:window.x=1",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>1</script>",
    "mailto:someone@example.com",
    "blob:https://example.com/id",
    "ftp://example.com/file",
    "not a url",
    "relative/path"
  ])("shows %s as text", (href) => {
    expect(safeLinkHref(href)).toBeNull();
  });
});

describe("link labels", () => {
  it("opens a link outside the app in a new tab and names its host", () => {
    expect(opensExternally("https://example.com/a")).toBe(true);
    expect(opensExternally("//example.com/a")).toBe(true);
    expect(opensExternally("/sessions/1")).toBe(false);
    expect(externalHost("https://example.com:8443/a")).toBe("example.com:8443");
    expect(externalHost("//example.com/a")).toBe("example.com");
  });

  it("names no host for a link inside the app", () => {
    expect(externalHost("/sessions/1")).toBeNull();
    expect(externalHost("#top")).toBeNull();
    expect(externalHost(`${API_URL}/artifacts/a-1/download`)).toBeNull();
  });

  it("reads a host from a URL, and falls back for a value that has none", () => {
    expect(hostLabel("https://www.example.com/a.png")).toBe("www.example.com");
    expect(hostLabel("data:text/plain,x")).toBe("unknown host");
    expect(hostInitial("https://www.example.com/a.png")).toBe("W");
    expect(hostInitial("https://9lives.test")).toBe("9");
    expect(hostInitial("not a url")).toBe("?");
  });
});

describe("number labels", () => {
  it("formats a coordinate with 4 decimals, and nothing for a value that is not finite", () => {
    expect(formatCoordinate(45.50169)).toBe("45.5017");
    expect(formatCoordinate(-73)).toBe("-73.0000");
    expect(formatCoordinate(Number.NaN)).toBe("");
    expect(formatCoordinate(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("formats a rating with its count", () => {
    expect(formatRating(4.5, 12)).toBe("4.5 (12)");
    expect(formatRating(4, undefined)).toBe("4");
    expect(formatRating(4.25, undefined)).toBe("4.3");
    expect(formatRating(undefined, 12)).toBeNull();
    expect(formatRating(Number.NaN, 12)).toBeNull();
    expect(formatRating(3, Number.NaN)).toBe("3");
  });

  it("keeps the column count of a grid between 1 and 4", () => {
    expect(gridColumns(undefined)).toBe(2);
    expect(gridColumns(Number.NaN)).toBe(2);
    expect(gridColumns(0)).toBe(1);
    expect(gridColumns(-3)).toBe(1);
    expect(gridColumns(3.9)).toBe(3);
    expect(gridColumns(50)).toBe(4);
  });
});


describe("safe paint", () => {
  it.each(["surface-secondary", "currentColor", "#abc", "#11223344", "rgb(20 30 40 / 50%)", "oklch(65% 0.2 120)"])("keeps a static color: %s", (value) => {
    expect(safePaint(value)).toBe(value);
  });
  it.each(["url(https://evil.test/secret)", 'u\\72l("https://evil.test/secret")', "image-set('https://evil.test/secret' 1x)", "var(--attacker-image)", "red; background:url(https://evil.test)"])("refuses a resource value: %s", (value) => {
    expect(safePaint(value)).toBeUndefined();
  });
  it("checks SVG shapes and chart series without changing data, children, URLs, or local setters", () => {
    const setValue = () => undefined;
    const props = { background: "url(https://evil.test)", text: "url(keep this text)", href: "https://example.test", setValue,
      paths: [{ d: "M0 0", fill: "url(https://evil.test)", stroke: "red" }], children: { color: "keep child" } };
    const result = safePaintProps("Svg", props);
    expect(result).toEqual({ ...props, background: undefined, paths: [{ d: "M0 0", fill: undefined, stroke: "red" }] });
    expect(props.background).toBe("url(https://evil.test)");
    expect(safePaintProps("Chart", { series: [{ key: "revenue", color: "url(https://evil.test)" }], data: [{ color: "original data" }] }))
      .toEqual({ series: [{ key: "revenue", color: undefined }], data: [{ color: "original data" }] });
  });
});
