// The generated UI theme bridge in globals.css, checked against the installed
// CopilotKit. The SDK draws generated UI with `--a2ui-*` variables and falls
// back to fixed light colors for any that is not set, so a missing mapping is a
// dark-mode defect that no type or render check catches (a table cell stayed
// #0d0d0d on a dark panel). The test reads the variables out of the installed
// package, so an SDK upgrade that adds or renames one fails here.

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHART_PALETTE, DARK_THEME } from "@copilotkit/shared/generative-ui";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// Read declarations and selector lists without depending on line breaks or indentation.
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1]!.split(";").at(-1)!.split(",").map(selector => selector.trim().replace(/\s+/g, " ")),
  declarations: new Map(match[2]!.split(";").flatMap(declaration => {
    const colon = declaration.indexOf(":");
    return colon < 0 ? [] : [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim().replace(/\s+/g, " ")]];
  }))
}));
function declarationsOf(selector: string): Map<string, string> {
  const rule = rules.find(rule => rule.selectors.includes(selector));
  expect(rule, `${selector} block`).toBeDefined();
  return rule!.declarations;
}

const reactCore = dirname(realpathSync(createRequire(import.meta.url).resolve("@copilotkit/react-core/package.json")));
const dist = join(reactCore, "dist");
const generativeUi = readFileSync(join(dist, "v2", "generative-ui.mjs"), "utf8");
const sharedDist = dirname(realpathSync(createRequire(import.meta.url).resolve("@copilotkit/shared/package.json")));
const tokens = readFileSync(join(sharedDist, "dist/generative-ui/standard/tokens.mjs"), "utf8");
const standardCss = readFileSync(join(sharedDist, "dist/generative-ui/standard/styles.mjs"), "utf8");

/** Variables that the components read by name. A name that ends in a dash is
 *  the start of a template, such as `--a2ui-color-text-${name}`. */
function sdkReadVariables(): Set<string> {
  return new Set([...`${generativeUi}\n${tokens}\n${standardCss}`.matchAll(/--a2ui-[a-z0-9-]*[a-z0-9]/g)].map((match) => match[0]));
}

// Left at the SDK value on purpose. Each reads fine in both themes, or is not
// a color. The test fails if the SDK stops using one that is listed here.
const LEFT_TO_THE_SDK: Record<string, string> = {
  "--a2ui-color-backdrop": "a black scrim behind a modal works on light and dark",
  "--a2ui-color-overlay": "a black scrim behind a lightbox image",
  "--a2ui-color-rating": "the amber of a rating star reads on both themes",
  "--a2ui-shadow-xs": "a one-pixel shadow; the app's shadows are larger and have no equivalent",
  "--a2ui-shadow-soft": "same as --a2ui-shadow-xs",
  "--a2ui-pulse-opacity": "motion, not a color",
  "--a2ui-pulse-scale": "motion, not a color",
  "--a2ui-heading-margin": "spacing, not a color",
  "--a2ui-block-margin": "spacing, not a color"
};

describe("the generated UI theme bridge", () => {
  const bridge = new Map([...declarationsOf(".a2ui-surface")].filter(([name]) => name.startsWith("--")));
  const themed = new Set(Object.keys(DARK_THEME));
  const read = sdkReadVariables();

  it("maps every color and shadow that the SDK themes, and each chart color", () => {
    expect(themed.size).toBeGreaterThan(50);
    const chartSeries = CHART_PALETTE.length;
    const wanted = new Set([...themed, ...Array.from({ length: chartSeries }, (_, index) => `--a2ui-chart-${index + 1}`)]);
    const missing = [...wanted].filter((name) => !bridge.has(name) && !(name in LEFT_TO_THE_SDK));
    expect(missing).toEqual([]);
  });

  it("declares only variables that the SDK reads, so a rename is a failure and not a silent miss", () => {
    const known = new Set([...themed, ...read, ...Array.from({ length: 6 }, (_, index) => `--a2ui-chart-${index + 1}`)]);
    expect([...bridge.keys()].filter((name) => !known.has(name))).toEqual([]);
  });

  it("leaves to the SDK only variables that it still reads", () => {
    const stale = Object.keys(LEFT_TO_THE_SDK).filter((name) => !themed.has(name) && !read.has(name));
    expect(stale).toEqual([]);
    expect(Object.keys(LEFT_TO_THE_SDK).filter((name) => bridge.has(name))).toEqual([]);
  });

  it("uses only app tokens that exist in the light and the dark theme, so the values follow the data-theme switch", () => {
    const light = declarationsOf("@theme");
    const dark = declarationsOf('[data-theme="dark"]');
    const used = new Set([...bridge.values()].flatMap((value) => [...value.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!)));
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((name) => !light.has(name))).toEqual([]);
    expect([...used].filter((name) => !dark.has(name))).toEqual([]);
    // No raw color: a literal would stay the same in both themes.
    const literal = [...bridge].filter(([, value]) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(value.replace(/var\([^)]*\)/g, "")));
    expect(literal).toEqual([]);
  });

  it("keeps SDK chart variables mapped to the app palette in both themes", () => {
    const sdkCss = readFileSync(join(dist, "v2", "index.css"), "utf8");
    const sdkCharts = new Set([...sdkCss.matchAll(/(--chart-\d+)\s*:/g)].map(match => match[1]!));
    const chatBridge = declarationsOf(".chat-surface [data-copilotkit]");
    const light = declarationsOf("@theme");
    const dark = declarationsOf('[data-theme="dark"]');
    const palettes = [
      ["#3d5a99", "#1a7a4a", "#7a5c00", "#9f403d", "#566166"],
      ["#8cb8ff", "#61d48c", "#f1c86a", "#ff8f87", "#b1bccb"]
    ];
    expect(sdkCharts.size).toBe(5);
    for (const name of sdkCharts) {
      const appToken = `--color-${name.slice(2)}`;
      expect(chatBridge.get(name), name).toBe(`var(${appToken})`);
      expect(bridge.get(`--a2ui-${name.slice(2)}`)).toBe(`var(${appToken})`);
      for (const [index, theme] of [light, dark].entries()) {
        expect(theme.get(appToken)).toBe(palettes[index]![Number(name.slice(-1)) - 1]);
      }
    }
  });

  it("sits outside .chat-surface, so the side panel gets it too", () => {
    const selectors = rules.flatMap(rule => rule.selectors).filter(selector => selector.includes(".a2ui-surface"));
    expect(selectors).toContain(".a2ui-surface");
    expect(selectors.filter(selector => selector.includes(".chat-surface"))).toEqual([]);
  });

  it("keeps the control edge separate from dividers and confines SDK edge fixes to controls", () => {
    expect(bridge.get("--a2ui-color-border-control")).toBe("var(--color-input)");
    expect(bridge.get("--a2ui-color-border-default")).toBe("var(--color-outline-variant)");
    for (const selector of [".a2ui-surface [data-a2ui-feedback-button]:not([data-a2ui-popover-trigger])", ".a2ui-surface [data-a2ui-carousel-arrow]"]) {
      expect(declarationsOf(selector).get("border-color")).toBe("var(--a2ui-color-border-control) !important");
    }
    expect(declarationsOf(".a2ui-surface [data-a2ui-carousel-arrow]:focus-visible").get("outline")).toBe("2px solid var(--a2ui-color-focus)");
  });
});

describe("the markdown table rules", () => {
  // globals.css styles each table of the chat and the panel, in no cascade
  // layer, so a utility class cannot beat it. ComparisonTable draws its own
  // table, with a sticky column that `overflow: hidden` breaks. It carries
  // data-app-table, and every rule below must skip that attribute.
  const selectors = rules.flatMap(rule => rule.selectors)
    .filter(selector => /^\.(?:md-body|chat-markdown) /.test(selector) && /\b(?:table|th|td)\b/.test(selector));

  it("skip a table that an application component marks", () => {
    expect(selectors).toHaveLength(12);
    expect(selectors.filter((selector) => !selector.includes("table:not([data-app-table])"))).toEqual([]);
  });
});
