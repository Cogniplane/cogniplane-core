// @vitest-environment jsdom
//
// The ComparisonTable and the StatusSummary of generated UI in the chat host,
// with the real CopilotKit provider, surface manager and CopilotChat, the real
// DeepAgentsBrowserAgent, and a fixture for the network. Both are read-only.
// The tests show a valid view in the chat and in the side panel, missing and
// zero data, long text, props that the catalog refuses, the theme that a view
// inherits, and the guide that still leaves the room for earlier records.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATIVE_UI_PANEL_TARGET, MAX_GENERATIVE_UI_CONTEXT_LENGTH } from "@cogniplane/shared-types";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./model-effort-selector", () => ({ ModelEffortSelector: () => null }));
vi.mock("./context-window-meter", () => ({ ContextWindowMeter: () => null }));

import { ev, FixtureServer, idleHistory, installBrowserLayoutStubs } from "../test-helpers/agui-fixture-server";
import { EARLIER_RECORDS_HEADING, MAX_EARLIER_RECORDS_CHARS } from "../lib/agui/deep-agents-browser-agent";
import { CopilotChatHost } from "./copilot-chat-host";
import { DRAFT_STORAGE_KEY, type DraftScope } from "./generative-ui-drafts.logic";

installBrowserLayoutStubs();

const USER: DraftScope = { userId: "user-1", tenantId: "tenant-1" };

let server: FixtureServer;
beforeEach(() => {
  server = new FixtureServer();
  vi.stubGlobal("fetch", server.fetch);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function hostElement() {
  return (
    <CopilotChatHost
      session={{ id: "s-1", initialToolStatuses: [], initialApprovals: [], canEdit: true }}
      modelSelection={{
        model: "model-1", effort: null, models: [], showEffortSelector: false,
        onModelChange: () => undefined, onEffortChange: () => undefined
      }}
      usage={{ contextTokens: 0, contextWindow: 1000, sessionCostUsd: 0 }}
      artifactIds={[]}
      draftScope={USER}
      events={{}}
    />
  );
}

const TABLE = "turn:a1:table";
const STATUS = "turn:a1:status";
const PLAN_COLUMNS = [{ id: "basic", label: "Basic" }, { id: "pro", label: "Pro" }, { id: "team", label: "Team" }];
const PLAN_ROWS = [
  { id: "price", label: "Price", cells: { basic: "$9/mo", pro: 29, team: null } },
  { id: "sso", label: "Single sign-on", cells: { basic: false, pro: true } },
  { id: "seats", label: "Seats", cells: { basic: 0, pro: 12345, team: "" } }
];
const ITEMS = [
  { id: "design", label: "Design", status: "complete", detail: "Signed off by Ada", completed: 4, total: 4 },
  { id: "build", label: "Build", status: "in-progress", detail: "Waiting on the API team", completed: 1, total: 8 },
  { id: "qa", label: "QA", status: "at-risk" },
  { id: "legal", label: "Legal review", status: "blocked", detail: "Contract not signed" },
  { id: "launch", label: "Launch", status: "not-started", completed: 0, total: 0 },
  { id: "docs", label: "Documentation" }
];

type Node = Record<string, unknown>;
const createSurface = (surfaceId: string, components: object[], dataModel: object = {}) =>
  [{ version: "v1.0", createSurface: { surfaceId, dataModel, components } }];
const table = (node: Node = {}, surfaceId = TABLE, dataModel: object = {}) => createSurface(surfaceId, [{
  id: "root", component: "ComparisonTable", title: "Plan comparison", columns: PLAN_COLUMNS, rows: PLAN_ROWS, ...node
}], dataModel);
const status = (node: Node = {}, surfaceId = STATUS, dataModel: object = {}) => createSurface(surfaceId, [{
  id: "root", component: "StatusSummary", title: "Release 4.2", completed: 7, total: 20, items: ITEMS, ...node
}], dataModel);
const activity = (operations: object[], target: string, surfaceId: string) => ({
  id: `genui:${surfaceId}`, role: "activity", activityType: "generative-ui-surface",
  content: { surfaceId, target, catalogId: "cogniplane/standard@1", operations, status: "ready", rejected: [] }
});
const history = (views: Array<{ operations: object[]; target?: string; surfaceId: string }>) => [
  { id: "u0", role: "user", content: "Show me the view" },
  { id: "a0", role: "assistant", content: "Here is the view." },
  ...views.map(({ operations, target = "chat", surfaceId }) => activity(operations, target, surfaceId))
];

const composer = () => screen.getByTestId("copilot-chat-textarea") as HTMLTextAreaElement;
const planTable = () => screen.findByRole("table", { name: "Plan comparison" });
const bodyCells = (root: HTMLElement) =>
  within(root).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
const panel = () => document.querySelector("aside[id^='side-panel-']") as HTMLElement;

/** A history view does not open the panel. The user opens it. */
async function openPanel() {
  await screen.findByText("Here is the view.");
  await waitFor(() => expect(screen.getByRole("button", { name: /^Side panel/ }).textContent).toContain("(has a view)"));
  fireEvent.click(screen.getByRole("button", { name: /^Side panel/ }));
}

/** Without a request, a button or a draft of values that go with the next message. */
function expectReadOnlyAndQuiet(root: HTMLElement) {
  expect(root.querySelectorAll("a, button, input, select, textarea, [onclick], img, iframe")).toHaveLength(0);
  expect(screen.queryByText(/go with your next message/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Use in reply" })).toBeNull();
  expect(server.calls).toEqual(["GET /sessions/s-1/connect"]);
  expect(server.sent).toEqual([]);
  expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
}

// Only app tokens carry color. A color that the theme cannot switch would stay
// light in dark mode, as a fixed #0d0d0d did before the theme bridge.
const RAW_COLOR = /^(?:text|bg|border|divide|fill|stroke|accent|ring|outline|from|to|via)-(?:\[|(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b)/;
function expectThemeTokensOnly(root: HTMLElement) {
  const elements = [root, ...root.querySelectorAll("*")];
  const classes = new Set(elements.flatMap((element) => (element.getAttribute("class") ?? "").split(/\s+/)).filter(Boolean));
  expect([...classes].filter((name) => RAW_COLOR.test(name) || name.startsWith("dark:"))).toEqual([]);
  expect(elements.filter((element) => /color|background|fill|stroke/i.test(element.getAttribute("style") ?? ""))).toEqual([]);
  // A semantic token class does appear, so the check above is not empty.
  expect([...classes].some((name) => /^(?:text|bg|border)-(?:on-surface|surface-container|outline-variant)/.test(name))).toBe(true);
}

describe("a ComparisonTable in the chat", () => {
  it("renders a native table named by its caption, with the values and the missing data of the model", async () => {
    server.connect("s-1", idleHistory(history([{ operations: table(), surfaceId: TABLE }])));
    render(hostElement());

    const element = await planTable();
    expect(within(element).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Criteria", "Basic", "Pro", "Team"]);
    expect(within(element).getAllByRole("rowheader").map((header) => header.textContent)).toEqual(["Price", "Single sign-on", "Seats"]);
    expect(bodyCells(element)).toEqual([
      ["$9/mo", "29", "No data"],
      ["No", "Yes", "No data"],
      // A zero is a value. A blank text and a column that a row leaves out are not.
      ["0", "12,345", "No data"]
    ]);
    const region = screen.getByRole("region", { name: "Plan comparison" });
    expect(region.tabIndex).toBe(0);
    expect(region.contains(element)).toBe(true);
    expectReadOnlyAndQuiet(region);
  });

  it("resolves props that the model binds to the data model, and still keeps no value of the user", async () => {
    const operations = table(
      { columns: { "@path": "/columns" }, rows: { "@path": "/rows" } }, TABLE, { columns: PLAN_COLUMNS, rows: PLAN_ROWS }
    );
    server.connect("s-1", idleHistory(history([{ operations, surfaceId: TABLE }])));
    render(hostElement());

    expect(bodyCells(await planTable())[0]).toEqual(["$9/mo", "29", "No data"]);
    expectReadOnlyAndQuiet(screen.getByRole("region", { name: "Plan comparison" }));
  });

  it("shows only missing data when no row has a value, and one row with no cells at all", async () => {
    const rows = [{ id: "a", label: "Empty row", cells: {} }, { id: "b", label: "Nulls", cells: { basic: null, pro: null, team: null } }];
    server.connect("s-1", idleHistory(history([{ operations: table({ rows }), surfaceId: TABLE }])));
    render(hostElement());

    expect(bodyCells(await planTable())).toEqual([["No data", "No data", "No data"], ["No data", "No data", "No data"]]);
  });

  it("keeps long text and the largest table that the schema allows inside the region", async () => {
    const longText = "Includes the full audit trail, the export of every record, and priority support. ".repeat(3).trim();
    const columns = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, label: index === 0 ? "L".repeat(120) : `Option ${index}` }));
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `r${index}`, label: index === 0 ? "R".repeat(120) : `Criterion ${index}`, cells: { c0: index === 0 ? longText : index, c1: index === 0 ? "x".repeat(300) : null }
    }));
    server.connect("s-1", idleHistory(history([{ operations: table({ title: "T".repeat(120), columns, rows }, TABLE), surfaceId: TABLE }])));
    render(hostElement());

    const element = await screen.findByRole("table", { name: "T".repeat(120) });
    expect(within(element).getAllByRole("row")).toHaveLength(31);
    expect(bodyCells(element)[0]!.slice(0, 2)).toEqual([longText, "x".repeat(300)]);
    expect(bodyCells(element)[29]).toEqual(["29", ...Array(7).fill("No data")]);
    const region = screen.getByRole("region", { name: "T".repeat(120) });
    expect(region.className).toContain("overflow-x-auto");
    // The page scrolls nowhere, because the region holds the width.
    expect(region.parentElement!.className).toContain("max-w-full");
  });

  it("inherits the theme of the page: only app tokens, inside the surface that the theme bridge covers", async () => {
    server.connect("s-1", idleHistory(history([{ operations: table(), surfaceId: TABLE }])));
    render(<div data-theme="dark">{hostElement()}</div>);

    const region = (await planTable()).closest("[role='region']") as HTMLElement;
    expect(region.closest(".a2ui-surface")).not.toBeNull();
    expect(region.closest("[data-theme='dark']")).not.toBeNull();
    expectThemeTokensOnly(region);
  });
});

describe("a StatusSummary in the chat", () => {
  it("renders the rows with a text status, honest counts, and a progress control only where counts exist", async () => {
    server.connect("s-1", idleHistory(history([{ operations: status(), surfaceId: STATUS }])));
    render(hostElement());

    const section = await screen.findByRole("region", { name: "Release 4.2" });
    expect(within(section).getByRole("heading", { level: 3 }).textContent).toBe("Release 4.2");
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("span[id]")?.textContent))
      .toEqual(["Design", "Build", "QA", "Legal review", "Launch", "Documentation"]);
    expect(rows.map((row) => /Status: (.*?)(?:Signed|Waiting|Contract|\d|$)/.exec(row.textContent ?? "")?.[1]?.trim()))
      .toEqual(["Complete", "In progress", "At risk", "Blocked", "Not started", "Status not reported"]);
    expect((within(section).getAllByRole("progressbar") as HTMLProgressElement[]).map((bar) => [bar.value, bar.max]))
      .toEqual([[7, 20], [4, 4], [1, 8]]);
    expect(within(section).getByText("7 of 20 completed")).toBeTruthy();
    expect(within(rows[4]!).getByText("0 of 0 completed")).toBeTruthy();
    expect(within(rows[4]!).queryByRole("progressbar")).toBeNull();
    expect(section.textContent).not.toContain("%");
    expectReadOnlyAndQuiet(section);
  });

  it("states an empty list, and a view with no counts shows no progress control", async () => {
    server.connect("s-1", idleHistory(history([
      { operations: status({ completed: undefined, total: undefined, items: [] }), surfaceId: STATUS },
      { operations: status({ title: "Second", completed: undefined, total: undefined, items: [{ id: "a", label: "Only row" }] }, "turn:a1:second"), surfaceId: "turn:a1:second" }
    ])));
    render(hostElement());

    await screen.findByText("No status items to show.");
    expect(screen.getByText("Status not reported")).toBeTruthy();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("inherits the theme of the page: semantic tokens only, inside the surface that the theme bridge covers", async () => {
    server.connect("s-1", idleHistory(history([{ operations: status(), surfaceId: STATUS }])));
    render(<div data-theme="dark">{hostElement()}</div>);

    const section = await screen.findByRole("region", { name: "Release 4.2" });
    expect(section.closest(".a2ui-surface")).not.toBeNull();
    expectThemeTokensOnly(section);
    // The four semantic colors of the design system all appear, each on a status of its own.
    const tones = [...section.querySelectorAll("span.bg-surface-container-lowest > span.rounded")].map((chip) => /text-(success|info|warning|danger)/.exec(chip.className)?.[1]);
    expect(tones.filter(Boolean)).toEqual(["success", "info", "warning", "danger"]);
  });
});

describe("the views in the side panel", () => {
  it("shows a ComparisonTable and keeps it read-only", async () => {
    server.connect("s-1", idleHistory(history([{ operations: table(), target: GENERATIVE_UI_PANEL_TARGET, surfaceId: TABLE }])));
    render(hostElement());
    await openPanel();

    const element = await within(panel()).findByRole("table", { name: "Plan comparison" });
    expect(bodyCells(element)[0]).toEqual(["$9/mo", "29", "No data"]);
    // Neither the chat transcript nor the panel holds a second copy.
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(within(panel()).getByRole("region", { name: "Plan comparison" }).tabIndex).toBe(0);
    expect(within(panel()).queryAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Close side panel"]);
    expect(screen.queryByText(/go with your next message/)).toBeNull();
    expect(server.sent).toEqual([]);
  });

  it("shows a StatusSummary, with the long text of a model, in the same panel frame", async () => {
    const items = ITEMS.map((item, index) => index === 1 ? { ...item, label: "B".repeat(120), detail: "D".repeat(300) } : item);
    server.connect("s-1", idleHistory(history([{ operations: status({ items, title: "S".repeat(120) }), target: GENERATIVE_UI_PANEL_TARGET, surfaceId: STATUS }])));
    render(hostElement());
    await openPanel();

    const section = await within(panel()).findByRole("region", { name: "S".repeat(120) });
    expect(within(section).getByText("B".repeat(120))).toBeTruthy();
    expect(within(section).getByText("D".repeat(300))).toBeTruthy();
    expect(within(section).getAllByRole("progressbar")).toHaveLength(3);
    expect(section.closest(".a2ui-surface")).not.toBeNull();
    expectThemeTokensOnly(section);
  });
});

describe("props that the catalog refuses", () => {
  /** What the SDK shows for a surface that it cannot render. */
  const refusals = () => screen.queryAllByText(/invalid props|couldn.t be shown/);

  it("renders nothing for a ComparisonTable with a duplicate id, an unknown cell key, a bad cell or too few columns", async () => {
    const duplicateColumn = table({ columns: [PLAN_COLUMNS[0], PLAN_COLUMNS[0]] }, "turn:a1:dup-column");
    const duplicateRow = table({ rows: [PLAN_ROWS[0], PLAN_ROWS[0]] }, "turn:a1:dup-row");
    const unknownKey = table({ rows: [{ id: "r", label: "R", cells: { nope: 1 } }] }, "turn:a1:unknown-key");
    const badCell = table({ rows: [{ id: "r", label: "R", cells: { basic: { nested: true } } }] }, "turn:a1:bad-cell");
    const oneColumn = table({ columns: [PLAN_COLUMNS[0]] }, "turn:a1:one-column");
    const reserved = table({ rows: [{ id: "constructor", label: "R", cells: {} }] }, "turn:a1:reserved");
    server.connect("s-1", idleHistory(history([
      { operations: duplicateColumn, surfaceId: "turn:a1:dup-column" },
      { operations: duplicateRow, surfaceId: "turn:a1:dup-row" },
      { operations: unknownKey, surfaceId: "turn:a1:unknown-key" },
      { operations: badCell, surfaceId: "turn:a1:bad-cell" },
      { operations: oneColumn, surfaceId: "turn:a1:one-column" },
      { operations: reserved, surfaceId: "turn:a1:reserved" }
    ])));
    render(hostElement());

    await screen.findByText("Here is the view.");
    await waitFor(() => expect(refusals()).toHaveLength(6));
    expect(screen.queryAllByRole("table")).toHaveLength(0);
    expect(screen.queryAllByRole("region", { name: "Plan comparison" })).toHaveLength(0);
  });

  it("renders nothing for a StatusSummary with a duplicate id, a status outside the list, or invalid counts", async () => {
    const cases: Array<[string, Node]> = [
      ["dup", { items: [ITEMS[0], ITEMS[0]] }],
      ["word", { items: [{ id: "a", label: "A", status: "done" }] }],
      ["negative", { items: [{ id: "a", label: "A", completed: -1, total: 3 }] }],
      ["over", { items: [{ id: "a", label: "A", completed: 4, total: 3 }] }],
      ["half", { items: [{ id: "a", label: "A", completed: 2 }] }],
      ["fraction", { completed: 1.5, total: 3, items: [] }],
      ["view-over", { completed: 9, total: 3, items: [] }]
    ];
    server.connect("s-1", idleHistory(history(cases.map(([name, node]) => ({ operations: status(node, `turn:a1:${name}`), surfaceId: `turn:a1:${name}` })))));
    render(hostElement());

    await screen.findByText("Here is the view.");
    await waitFor(() => expect(refusals()).toHaveLength(cases.length));
    expect(screen.queryAllByRole("region", { name: "Release 4.2" })).toHaveLength(0);
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("rejects an operation that gives either component an event, a link or a request, and opens nothing", async () => {
    const openUrl = { functionCall: { "@call": "openUrl", args: { url: "https://evil.test/click" } } };
    const hostile = { onClick: openUrl, onVisible: openUrl, href: "https://evil.test/x", url: "https://evil.test/y", highlight: "pro", setValue: "x" };
    server.connect("s-1", idleHistory(history([
      { operations: table(hostile, "turn:a1:hostile-table"), surfaceId: "turn:a1:hostile-table" },
      { operations: status(hostile, "turn:a1:hostile-status"), surfaceId: "turn:a1:hostile-status" }
    ])));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(hostElement());

    await screen.findByText("Here is the view.");
    await waitFor(() => expect(screen.queryAllByText(/couldn.t be shown/)).toHaveLength(2));
    expect(screen.queryAllByRole("table")).toHaveLength(0);
    expect(screen.queryAllByRole("region", { name: "Release 4.2" })).toHaveLength(0);
    expect(document.querySelectorAll("a, img, iframe")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("evil.test");
    expect(open).not.toHaveBeenCalled();
    expect(server.calls).toEqual(["GET /sessions/s-1/connect"]);
    expect(server.sent).toEqual([]);
  });
});

describe("the catalog guide with the larger catalog", () => {
  it("names both components for the model and still leaves the full budget for earlier records", async () => {
    server.connect("s-1", idleHistory(history([{ operations: table(), surfaceId: TABLE }, { operations: status(), surfaceId: STATUS }])));
    server.messageReplies = [(stream) => { stream.push(ev.runStarted("a9"), ev.runFinished("a9")); stream.finish(); }];
    render(hostElement());
    await planTable();
    fireEvent.change(composer(), { target: { value: "Thanks" } });
    await waitFor(() => expect((screen.getByTestId("copilot-send-button") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.keyDown(composer(), { key: "Enter" }); });
    await waitFor(() => expect(server.sent).toHaveLength(1));

    const context = String(server.sent[0]!.generativeUiContext);
    expect(context).toContain("ComparisonTable");
    expect(context).toContain("StatusSummary");
    expect(context).toContain("Never invent a value");
    expect(context).toContain("Never estimate or compute a count");
    // The two views hold no value of the user, so no earlier record exists to send.
    expect(context).not.toContain('"userValues"');
    const guideLength = context.includes(`\n\n${EARLIER_RECORDS_HEADING}`)
      ? context.length - context.slice(context.indexOf(`\n\n${EARLIER_RECORDS_HEADING}`)).length
      : context.length;
    expect(MAX_GENERATIVE_UI_CONTEXT_LENGTH - guideLength - 400).toBeGreaterThan(MAX_EARLIER_RECORDS_CHARS);
  });
});
