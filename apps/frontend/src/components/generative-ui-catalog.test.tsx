// @vitest-environment jsdom
import { exportA2UICatalog, standardUI } from "@copilotkit/react-core/v2/generative-ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { GenerativeArtifactCard } from "./artifact-card";
import { GenerativeChecklist } from "./checklist-card";
import { GenerativeComparisonTable } from "./comparison-table";
import { COGNIPLANE_GENERATIVE_UI, GENERATIVE_UI_CONFIG, withoutModelEvents } from "./generative-ui-catalog";
import { GenerativeStatusSummary } from "./status-summary";

const APPLICATION_COMPONENTS = ["ArtifactCard", "Checklist", "ComparisonTable", "StatusSummary"];
const PRESENTATION_DESCRIPTIONS = ["Button", "Pressable", "Form", "FollowUp", "Image", "ImageGrid", "CarouselMediaItem", "LinkCard", "EntityCard", "Citation", "Favicon", "Video", "AudioPlayer", "Map", "HtmlView", "Markdown"];
afterEach(cleanup);

describe("COGNIPLANE_GENERATIVE_UI", () => {
  it("keeps all 69 standard components, with the same schema for the model, and adds only the four application components", () => {
    const names = [...standardUI.components.keys()];

    expect(names).toHaveLength(69);
    expect([...COGNIPLANE_GENERATIVE_UI.components.keys()]).toEqual([...names, ...APPLICATION_COMPONENTS]);
    const {
      ArtifactCard: artifactCard, Checklist: checklist, ComparisonTable: comparison, StatusSummary: status, ...standardManifest
    } = COGNIPLANE_GENERATIVE_UI.manifestComponents;
    for (const [name, manifest] of Object.entries(standardManifest)) {
      const original = standardUI.manifestComponents[name];
      expect({ ...manifest, description: undefined }).toEqual({ ...original, description: undefined });
      expect(manifest.description === original.description, name).toBe(!PRESENTATION_DESCRIPTIONS.includes(name));
    }
    expect(Object.keys(exportA2UICatalog(COGNIPLANE_GENERATIVE_UI).components)).toEqual([...names, ...APPLICATION_COMPONENTS]);
    // The id stays, so surfaces saved before these components still name this catalog.
    expect(COGNIPLANE_GENERATIVE_UI.id).toBe("cogniplane/standard@1");
    // No application state or function.
    expect([...COGNIPLANE_GENERATIVE_UI.functions.keys()]).toEqual([...standardUI.functions.keys()]);
    expect([...COGNIPLANE_GENERATIVE_UI.state.keys()]).toEqual([...standardUI.state.keys()]);
    expect([artifactCard, checklist, comparison, status].every((manifest) => manifest !== undefined)).toBe(true);
  });

  it("gives Checklist data props, two writable props with setters, and no event or slot", () => {
    const definition = COGNIPLANE_GENERATIVE_UI.components.get("Checklist")!;

    expect(definition.component).toBe(GenerativeChecklist);
    expect(definition.propKeys).toEqual(["title", "items", "checked", "notes"]);
    expect(definition.writable).toEqual(["checked", "notes"]);
    expect(definition.events ?? {}).toEqual({});
    expect(definition.slots ?? {}).toEqual({});
    expect(definition.selectors).toEqual({});
    // The model reads how to bind the writable props.
    const manifest = COGNIPLANE_GENERATIVE_UI.manifestComponents.Checklist as { description: string; props: { additionalProperties: boolean } };
    expect(manifest.description).toContain('"checked": {"@path": "/release/checked"}');
    expect(manifest.description).toContain('"notes": {"@path": "/release/notes"}');
    expect(manifest.description).toContain("A literal checked or notes value makes the checklist read-only");
    expect(manifest.props.additionalProperties).toBe(false);
  });

  it("accepts a bounded checklist, all unchecked included, and rejects bad ids and values", () => {
    const definition = COGNIPLANE_GENERATIVE_UI.components.get("Checklist")!;
    const validate = (value: unknown) => definition.props!["~standard"].validate(value) as { value?: unknown; issues?: unknown[] };
    const items = [{ id: "tests", label: "Tests pass" }, { id: "rollback-plan_2", label: "x".repeat(200), description: "Owner: Ada" }];

    expect(validate({ items }).issues).toBeUndefined();
    expect(validate({ items, checked: { tests: false, "rollback-plan_2": false }, notes: "" }).issues).toBeUndefined();
    expect(validate({ title: "Release", items, checked: { tests: true }, notes: "n".repeat(2_000) }).issues).toBeUndefined();

    expect(validate({ items: [] }).issues).toBeDefined();
    expect(validate({ items: Array.from({ length: 31 }, (_, index) => ({ id: `i${index}`, label: "Item" })) }).issues).toBeDefined();
    expect(validate({ items: [items[0], { id: "tests", label: "Again" }] }).issues).toBeDefined();
    for (const id of ["", "-start", "has space", "a/b", "__proto__", "constructor", "prototype", "x".repeat(65)]) {
      expect(validate({ items: [{ id, label: "Item" }] }).issues, id).toBeDefined();
    }
    expect(validate({ items: [{ id: "a", label: " " }] }).issues).toBeDefined();
    expect(validate({ items: [{ id: "a", label: "x".repeat(201) }] }).issues).toBeDefined();
    expect(validate({ items, checked: { tests: "yes" } }).issues).toBeDefined();
    expect(validate({ items, checked: { unknown: true } }).issues).toBeDefined();
    expect(validate({ items, notes: 3 }).issues).toBeDefined();
    expect(validate({ items, notes: "n".repeat(2_001) }).issues).toBeDefined();
  });

  it.each([
    ["ComparisonTable", GenerativeComparisonTable, ["title", "columns", "rows"]],
    ["StatusSummary", GenerativeStatusSummary, ["title", "completed", "total", "items"]]
  ] as const)("gives %s data props only: no event, slot, setter, binding or writable prop", (name, component, propKeys) => {
    const definition = COGNIPLANE_GENERATIVE_UI.components.get(name)!;

    expect(definition.component).toBe(component);
    expect(definition.propKeys).toEqual(propKeys);
    expect(definition.events ?? {}).toEqual({});
    expect(definition.slots ?? {}).toEqual({});
    expect(definition.writable ?? []).toEqual([]);
    expect(definition.selectors).toEqual({});
    expect(definition.childRefs).toEqual([]);
    const manifest = COGNIPLANE_GENERATIVE_UI.manifestComponents[name] as { props: { additionalProperties: boolean } };
    expect(manifest.props.additionalProperties).toBe(false);
  });

  it("tells the model when to use ComparisonTable and StatusSummary, and gives the exact contract", () => {
    const description = (name: string) => (COGNIPLANE_GENERATIVE_UI.manifestComponents[name] as { description: string }).description;

    const comparison = description("ComparisonTable");
    for (const part of [
      "read-only table", "when the user asks you to compare options", "no ranking, score or highlight", "title: at most 120",
      "columns: 2 to 8 objects { id, label }", "rows: 1 to 30 objects { id, label, cells }", "at most 300 characters",
      "a number, true, false, or null", "Never invent a value", '"No data"', "A key of cells that is not a column id makes the props invalid",
      "(at most 64 characters)", "between -1e15 and 1e15", "Example:"
    ]) expect(comparison, part).toContain(part);

    const status = description("StatusSummary");
    for (const part of [
      "read-only status view", "asks for the status or the progress", "title: at most 120",
      "items: 0 to 30 objects { id, label, status?, detail?, completed?, total? }",
      '"not-started", "in-progress", "at-risk", "blocked", "complete"', "Status not reported", "put a reason in detail, never in status",
      "completed at most total, set together or not at all", "total above 0 gets a progress bar", "Never estimate or compute a count",
      "at the top level only when your data gives a count for the whole view", "Do not add up the rows",
      "Use the title to name what the whole-view count measures", "detail: at most 300", "Example:"
    ]) expect(status, part).toContain(part);
    // The two examples are valid props, so a model that copies one renders it.
    for (const name of ["ComparisonTable", "StatusSummary"]) {
      const example = JSON.parse(/Example: (\{.*\})\.$/.exec(description(name))![1]!);
      const definition = COGNIPLANE_GENERATIVE_UI.components.get(name)!;
      expect((definition.props!["~standard"].validate(example) as { issues?: unknown[] }).issues, name).toBeUndefined();
    }
  });

  describe("ComparisonTable props", () => {
    type Cells = Record<string, unknown>;
    const validate = (value: unknown) =>
      COGNIPLANE_GENERATIVE_UI.components.get("ComparisonTable")!.props!["~standard"].validate(value) as
        { value?: { rows: Array<{ cells: Cells }> }; issues?: unknown[] };
    const columns = [{ id: "basic", label: "Basic" }, { id: "pro", label: "Pro" }];
    const rows = [{ id: "price", label: "Price", cells: { basic: "$9", pro: 29 } }];
    const rejected = (value: unknown, message?: RegExp) => {
      const issues = validate(value).issues as Array<{ message: string }> | undefined;
      expect(issues).toBeDefined();
      if (message) expect(issues!.map((issue) => issue.message).join("\n")).toMatch(message);
    };

    it("accepts bounded data of every cell type, a missing cell and the limits", () => {
      expect(validate({ columns, rows }).issues).toBeUndefined();
      expect(validate({ title: "Plans", columns, rows: [{ id: "r", label: "R", cells: { basic: true, pro: null } }] }).issues).toBeUndefined();
      expect(validate({ columns, rows: [{ id: "r", label: "R", cells: {} }] }).issues).toBeUndefined();
      expect(validate({ columns, rows: [{ id: "r", label: "R", cells: { basic: 0, pro: false } }] }).issues).toBeUndefined();
      expect(validate({ columns, rows: [{ id: "r", label: "R", cells: { basic: "x".repeat(300), pro: -1e15 } }] }).issues).toBeUndefined();
      const eight = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, label: "C" }));
      const thirty = Array.from({ length: 30 }, (_, index) => ({ id: `r${index}`, label: "R", cells: {} }));
      expect(validate({ title: "t".repeat(120), columns: eight, rows: thirty }).issues).toBeUndefined();
    });

    it("rejects too few or too many columns and rows, and texts over a bound", () => {
      rejected({ columns: [columns[0]], rows });
      rejected({ columns: Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, label: "C" })), rows });
      rejected({ columns, rows: [] });
      rejected({ columns, rows: Array.from({ length: 31 }, (_, index) => ({ id: `r${index}`, label: "R", cells: {} })) });
      rejected({ columns, rows: [{ id: "r", label: "R", cells: { basic: "x".repeat(301) } }] });
      rejected({ columns: [{ id: "a", label: "x".repeat(121) }, columns[1]], rows });
      rejected({ columns, rows: [{ id: "r", label: " ", cells: {} }] });
      rejected({ columns, rows, title: "t".repeat(121) });
      rejected({ columns, rows, title: " " });
      rejected({ columns, rows: [{ id: "r", label: "x".repeat(121), cells: {} }] });
    });

    it("rejects values of another type, and numbers that the table could not print as given", () => {
      for (const cell of [{ nested: 1 }, ["a"], undefined, Number.NaN, Number.POSITIVE_INFINITY, 1e15 + 1e6, -1e16]) {
        rejected({ columns, rows: [{ id: "r", label: "R", cells: { basic: cell } }] });
      }
      rejected({ columns: "Basic, Pro", rows });
      rejected({ columns, rows: "Price" });
      rejected({ columns, rows: [{ id: "r", label: "R", cells: [1, 2] }] });
      rejected({ columns, rows: [{ id: "r", label: "R" }] });
      rejected({});
    });

    it("rejects duplicate and reserved ids, and a cell key that is not a column id", () => {
      rejected({ columns: [columns[0], columns[0]], rows }, /Duplicate column id "basic"/);
      rejected({ columns, rows: [rows[0], rows[0]] }, /Duplicate row id "price"/);
      rejected({ columns, rows: [{ id: "r", label: "R", cells: { nope: 1 } }] }, /No column has the id "nope"/);
      rejected({ columns, rows: [{ id: "r", label: "R", cells: { "bad key": 1 } }] });
      for (const id of ["", "-start", "has space", "a/b", "__proto__", "constructor", "prototype", "x".repeat(65)]) {
        rejected({ columns: [{ id, label: "C" }, columns[1]], rows });
        rejected({ columns, rows: [{ id, label: "R", cells: {} }] });
      }
    });

    it("drops a __proto__ key from the cells, so it never reaches the table, and keeps the real prototype", () => {
      const cells = JSON.parse('{"__proto__": {"polluted": true}, "basic": "ok"}');
      const result = validate({ columns, rows: [{ id: "r", label: "R", cells }] });

      expect(result.issues).toBeUndefined();
      expect(Object.keys(result.value!.rows[0]!.cells)).toEqual(["basic"]);
      expect(Object.getPrototypeOf(result.value!.rows[0]!.cells)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("drops props that it does not declare", () => {
      const result = validate({ columns, rows, onClick: "x", href: "https://evil.test", highlight: "pro" });
      expect(Object.keys(result.value!)).toEqual(["columns", "rows"]);
    });
  });

  describe("StatusSummary props", () => {
    const validate = (value: unknown) =>
      COGNIPLANE_GENERATIVE_UI.components.get("StatusSummary")!.props!["~standard"].validate(value) as
        { value?: { items: object[] }; issues?: unknown[] };
    const item = { id: "build", label: "Build", status: "in-progress", detail: "Waiting", completed: 3, total: 8 };
    const rejected = (value: unknown, message?: RegExp) => {
      const issues = validate(value).issues as Array<{ message: string }> | undefined;
      expect(issues).toBeDefined();
      if (message) expect(issues!.map((issue) => issue.message).join("\n")).toMatch(message);
    };

    it("accepts an empty list, rows without a status or counts, counts at both levels, and the limits", () => {
      expect(validate({ items: [] }).issues).toBeUndefined();
      expect(validate({ title: "Release", items: [{ id: "a", label: "A" }] }).issues).toBeUndefined();
      expect(validate({ title: "Release", completed: 3, total: 8, items: [item] }).issues).toBeUndefined();
      expect(validate({ items: [{ id: "a", label: "A", completed: 0, total: 0 }] }).issues).toBeUndefined();
      expect(validate({ items: [{ id: "a", label: "A", completed: 5, total: 5 }] }).issues).toBeUndefined();
      expect(validate({ items: [{ id: "a", label: "A", detail: "" }] }).issues).toBeUndefined();
      for (const status of ["not-started", "in-progress", "at-risk", "blocked", "complete"]) {
        expect(validate({ items: [{ id: "a", label: "A", status }] }).issues, status).toBeUndefined();
      }
      const thirty = Array.from({ length: 30 }, (_, index) => ({ id: `i${index}`, label: "x".repeat(120), detail: "d".repeat(300) }));
      expect(validate({ title: "t".repeat(120), completed: 1_000_000, total: 1_000_000, items: thirty }).issues).toBeUndefined();
    });

    it("rejects invalid counts: negative, fractional, too large, one of a pair, or completed above total", () => {
      rejected({ items: [{ ...item, completed: -1 }] });
      rejected({ items: [{ ...item, completed: 1.5 }] });
      rejected({ items: [{ ...item, total: 1_000_001 }] });
      rejected({ items: [{ ...item, completed: "3" }] });
      rejected({ items: [{ ...item, completed: Number.NaN }] });
      rejected({ items: [{ ...item, completed: undefined }] }, /together, or neither/);
      rejected({ items: [{ ...item, total: undefined }] }, /together, or neither/);
      rejected({ items: [{ ...item, completed: 9, total: 8 }] }, /completed is larger than total/);
      rejected({ completed: 4, items: [] }, /together, or neither/);
      rejected({ completed: 9, total: 8, items: [] }, /completed is larger than total/);
    });

    it("rejects a status outside the list, wording that only sounds like one, and values of another type", () => {
      for (const status of ["done", "Complete", "success", "green", "COMPLETE", "complete ", "", null, 1, true]) {
        rejected({ items: [{ ...item, status }] });
      }
      rejected({ items: "none" });
      rejected({ items: [{ ...item, label: " " }] });
      rejected({ items: [{ ...item, label: "x".repeat(121) }] });
      rejected({ items: [{ ...item, detail: "x".repeat(301) }] });
      rejected({ title: "t".repeat(121), items: [] });
      rejected({});
      rejected({ items: Array.from({ length: 31 }, (_, index) => ({ id: `i${index}`, label: "I" })) });
    });

    it("rejects duplicate and reserved ids", () => {
      rejected({ items: [item, item] }, /Duplicate item id "build"/);
      for (const id of ["", "-start", "has space", "a/b", "__proto__", "constructor", "prototype", "x".repeat(65)]) {
        rejected({ items: [{ ...item, id }] });
      }
    });

    it("drops props that it does not declare", () => {
      const result = validate({ items: [{ ...item, href: "https://evil.test", onClick: "x", percent: 90 }], onVisible: "x", percent: 90 });
      expect(Object.keys(result.value!)).toEqual(["items"]);
      expect(Object.keys(result.value!.items[0]!)).toEqual(["id", "label", "status", "detail", "completed", "total"]);
    });
  });

  it("gives ArtifactCard one model prop, a UUID artifactId, and no event, slot, setter or binding", () => {
    const card = COGNIPLANE_GENERATIVE_UI.components.get("ArtifactCard")!;

    expect(card.component).toBe(GenerativeArtifactCard);
    expect(card.propKeys).toEqual(["artifactId"]);
    expect(card.events ?? {}).toEqual({});
    expect(card.slots ?? {}).toEqual({});
    expect(card.writable ?? []).toEqual([]);
    expect(card.selectors).toEqual({});
    expect(card.childRefs).toEqual([]);
    const props = exportA2UICatalog(COGNIPLANE_GENERATIVE_UI).components.ArtifactCard as { properties: Record<string, unknown> };
    expect(Object.keys(props.properties)).toEqual(expect.arrayContaining(["artifactId"]));
    expect(Object.keys(props.properties).filter((key) => !["id", "component", "artifactId", "accessibility", "catalogId", "metadata"].includes(key))).toEqual([]);

    const validate = (value: unknown) => card.props!["~standard"].validate(value) as { value?: unknown; issues?: unknown[] };
    const id = "8f14e45f-ea2c-4f6b-9a3d-8a2e1c7d0b11";
    // The SDK rejects an operation with these extra props first (see the host
    // test). The schema also drops them, so they cannot reach the component.
    expect(validate({ artifactId: id, artifactName: "Fake.pdf", status: "ready", url: "https://evil.test/x", onClick: "x" }).value)
      .toEqual({ artifactId: id });
    expect(validate({ artifactId: "../../etc/passwd" }).issues).toBeDefined();
    expect(validate({}).issues).toBeDefined();
  });

  it("wraps every standard renderer and preserves its schema", () => {
    const withEvents = [...standardUI.components].filter(([, standard]) => Object.keys(standard.events ?? {}).length > 0).map(([name]) => name);
    // The events of the standard catalog, so that a new event of a later CopilotKit shows here.
    expect(withEvents).toEqual([
      "Box", "Column", "Row", "Grid", "GridItem", "Card", "Flow", "FlowItem", "Carousel", "CarouselItem",
      "CarouselMediaItem", "Button", "Pressable", "Form", "List", "ListItem", "Image", "LinkCard", "FollowUp", "EntityCard"
    ]);

    for (const [name, standard] of standardUI.components) {
      const ours = COGNIPLANE_GENERATIVE_UI.components.get(name)!;
      expect(ours.component, name).not.toBe(standard.component);
      expect(ours.component.displayName).toBe(`WithoutModelEvents(${name})`);
      // The definition stays: the model sees the same props, events, and slots.
      expect({ ...ours, component: undefined, description: undefined }).toEqual({ ...standard, component: undefined, description: undefined });
    }
  });

  it("keeps markdown history while the browser agent supplies the tool guide", () => {
    expect(GENERATIVE_UI_CONFIG).toEqual({ ui: COGNIPLANE_GENERATIVE_UI, transport: "markdown", sendContext: false });
  });
});

describe("generated action presentation", () => {
  const component = (name: string) => COGNIPLANE_GENERATIVE_UI.components.get(name)!.component;

  it("confirms the stripped SDK button stays enabled, then explains and disables the unavailable action", () => {
    const standard = standardUI.components.get("Button")!;
    const Before = withoutModelEvents("Button", standard.component, Object.keys(standard.events!));
    const event = vi.fn();
    const before = render(<Before label="Run review" onClick={event} />);
    const original = screen.getByRole("button", { name: "Run review" }) as HTMLButtonElement;
    expect(original.disabled).toBe(false);
    fireEvent.click(original);
    expect(event).not.toHaveBeenCalled();
    before.unmount();
    const Button = component("Button");
    render(<Button label="Run review" onClick={event} />);
    const button = screen.getByRole("button", { name: "Run review" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toContain("Ask in the chat");
    fireEvent.click(button);
    expect(event).not.toHaveBeenCalled();
  });

  it("keeps supported click-only link and copy behavior without calling the model", async () => {
    const Button = component("Button");
    const Pressable = component("Pressable");
    const event = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<><Button label="Read source" href="https://example.invalid/source" onClick={event} /><Button label="Copy excerpt" copy="Fictional excerpt" onClick={event} /><Pressable href="https://example.invalid/supplier" onClick={event}>Supplier source</Pressable></>);
      fireEvent.click(screen.getByRole("button", { name: "Read source" }));
      fireEvent.click(screen.getByRole("button", { name: "Copy excerpt" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "Supplier source" }), { key: "Enter" });
      expect(open.mock.calls.map(call => call[0])).toEqual(["https://example.invalid/source", "https://example.invalid/supplier"]);
      expect(writeText).toHaveBeenCalledWith("Fictional excerpt");
      expect(event).not.toHaveBeenCalled();
      await Promise.resolve();
    } finally {
      open.mockRestore();
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("keeps nested writable fields and location selection local while refusing press, submit and follow-up events", () => {
    const Pressable = component("Pressable");
    const Form = component("Form");
    const Button = component("Button");
    const Field = component("TextField");
    const Map = component("Map");
    const FollowUp = component("FollowUp");
    const event = vi.fn();
    function Sample() {
      const [value, setValue] = useState("");
      const [selected, setSelected] = useState("");
      return <><Pressable onClick={event} onVisible={event}><Field label="Local note" value={value} setValue={setValue} /></Pressable>
        <Form label="Planning" onSubmit={event}><Field label="Form note" value={value} setValue={setValue} /><Button label="Submit" submit onClick={event} /></Form>
        <Map markers={[{ label: "Office", lat: 1, lng: 2 }]} selected={selected} setSelected={setSelected} />
        <FollowUp items={[{ label: "Next step", message: "Draft the plan" }]} onFollowUp={event} />
        <output>{value} / {selected}</output></>;
    }
    const { container } = render(<Sample />);
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
    expect(screen.getByText("Draft the plan")).toBeDefined();
    fireEvent.change(screen.getByRole("textbox", { name: "Local note" }), { target: { value: "Keep local" } });
    expect((screen.getByRole("textbox", { name: "Form note" }) as HTMLInputElement).value).toBe("Keep local");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Form note" }), { key: "Enter" });
    expect(fireEvent.submit(container.querySelector("form")!)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Office/ }));
    expect(screen.getByRole("button", { name: /Office/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Keep local / Office");
    expect(event).not.toHaveBeenCalled();
  });

  it("uses URL identity, escapes HTML and never creates external image, player, map or frame elements", () => {
    const LinkCard = component("LinkCard");
    const Html = component("HtmlView");
    const Image = component("Image");
    const Video = component("Video");
    const Audio = component("AudioPlayer");
    const Map = component("Map");
    const { container } = render(<><LinkCard href="https://actual.example.invalid/report" title="Research" domain="trusted.example.invalid" />
      <Html html={'<script>alert("no")</script><iframe src="https://external.invalid" />'} />
      <Image url="https://external.invalid/image" description="External sample" /><Video url="javascript:refused" /><Audio url="https://external.invalid/audio" /><Map markers={[]} setSelected={vi.fn()} /></>);
    expect(screen.queryByText("trusted.example.invalid")).toBeNull();
    expect(screen.getByText("actual.example.invalid")).toBeDefined();
    expect(container.querySelector("pre")?.textContent).toContain("<script>");
    expect(container.querySelector("img,video,audio,iframe,script,canvas")).toBeNull();
    expect(screen.getByText("No locations to show.")).toBeDefined();
    expect([...container.querySelectorAll("a")].every(link => !link.href.startsWith("javascript:"))).toBe(true);
  });

  it("keeps Modal model-open blocked while allowing its own local trigger click", () => {
    const Modal = component("Modal");
    const Button = component("Button");
    const event = vi.fn();
    const setOpen = vi.fn();
    render(<Modal title="Local details" open setOpen={setOpen} trigger={<Button label="Open details" onClick={event} />} content={<p>Local detail content</p>} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Open details" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog").textContent).toContain("Local detail content");
    expect(event).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  });
});

describe("withoutModelEvents", () => {
  it("drops the event props, and passes every other prop, the setters and the children included", () => {
    const received: Record<string, unknown>[] = [];
    const Stub = (props: Record<string, unknown>) => { received.push(props); return null; };
    const Wrapped = withoutModelEvents("Field", Stub, ["onClick", "onVisible"]);
    const onClick = () => undefined;
    const setValue = () => undefined;

    render(<Wrapped label="Seats" value="3" setValue={setValue} onClick={onClick} onVisible={onClick} onOther={onClick}>child</Wrapped>);

    expect(received).toHaveLength(1);
    expect(Object.keys(received[0]!).sort()).toEqual(["children", "label", "onOther", "setValue", "value"]);
    expect(received[0]!.setValue).toBe(setValue);
  });
});

describe("maplibre-gl alias", () => {
  it("rejects the import of CopilotKit's standard Map, so no map code or tile request exists", async () => {
    // next.config.ts aliases "maplibre-gl" to this module. The standard Map
    // treats a rejected import as a missing optional peer.
    await expect(import("../lib/maplibre-gl-unavailable")).rejects.toThrow(/load no map tiles/);
  });
});
