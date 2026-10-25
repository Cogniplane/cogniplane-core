// @vitest-environment jsdom
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const copilotRequire = createRequire(require.resolve("@copilotkit/react-core"));
const rendererPath = copilotRequire.resolve("@copilotkit/a2ui-renderer");
const rendererRequire = createRequire(rendererPath);
const corePath = rendererRequire.resolve("@a2ui/web_core/v0_9");
const coreRequire = createRequire(corePath);
const sharedRequire = createRequire(require.resolve("@cogniplane/shared-types"));
const { z } = coreRequire("zod");
const core = await import(pathToFileURL(corePath).href);
const catalogUtils = await import(pathToFileURL(join(dirname(rendererPath), "react-renderer/catalog-utils.mjs")).href);
const catalogUtilsCjs = rendererRequire("./react-renderer/catalog-utils.cjs");

function exampleCatalog() {
  const schema = z.object({
    label: z.string().min(2),
    count: z.number().int().default(1),
    coordinates: z.tuple([z.number(), z.number()]).optional()
  });
  const format = core.createFunctionImplementation({
    name: "format", returnType: "string", schema: z.object({ value: z.string() })
  }, ({ value }: { value: string }) => value.toUpperCase());
  return new core.Catalog("https://example.test/catalog", [{ name: "Example", schema }], [format],
    z.object({ accent: z.string() }));
}

describe("Zod 4 dependency compatibility", () => {
  it("keeps CopilotKit and the browser on the same AG-UI client and patched Zod release", () => {
    expect(copilotRequire.resolve("@ag-ui/client")).toBe(require.resolve("@ag-ui/client"));
    const clientRequire = createRequire(require.resolve("@ag-ui/client"));
    const backendRequire = createRequire(require.resolve("../../../backend/package.json"));
    expect(backendRequire.resolve("@ag-ui/client")).toBe(require.resolve("@ag-ui/client"));
    expect(clientRequire.resolve("rxjs")).toBe(backendRequire.resolve("rxjs"));
    expect(clientRequire.resolve("zod")).toBe(coreRequire.resolve("zod"));
    expect(coreRequire.resolve("zod")).toBe(sharedRequire.resolve("zod"));
    expect(coreRequire("zod/package.json").version).toMatch(/^4\./);
  });

  it("validates A2UI messages and function arguments without accepting unknown wire fields", () => {
    const message = { version: "v0.9", createSurface: { surfaceId: "surface", catalogId: "catalog" } };
    expect(core.CreateSurfaceMessageSchema.safeParse(message).success).toBe(true);
    expect(core.CreateSurfaceMessageSchema.safeParse({ ...message, unexpected: true }).success).toBe(false);
    expect(core.CreateSurfaceMessageSchema.safeParse({
      ...message, createSurface: { ...message.createSurface, surfaceId: 3 }
    }).success).toBe(false);
    expect(core.FunctionCallSchema.parse({ call: "format", args: { value: "hello" } }).args)
      .toEqual({ value: "hello" });
    expect(core.FunctionCallSchema.safeParse({ call: "format", args: 3 }).success).toBe(false);
  });

  it("resolves optional, nested and array bindings and follows data changes", async () => {
    const catalog = new core.Catalog("catalog", [], []);
    const surface = new core.SurfaceModel("surface", catalog);
    surface.dataModel.set("/label", "Before");
    surface.componentsModel.addComponent(new core.ComponentModel("component", "Example", {
      text: { path: "/label" }, rows: [{ label: { path: "/label" } }]
    }));
    const schema = z.object({
      text: core.DynamicStringSchema.optional(),
      rows: z.array(z.object({ label: core.DynamicStringSchema })).default([])
    });
    const binder = new core.GenericBinder(new core.ComponentContext(surface, "component"), schema);
    const subscription = binder.subscribe(() => {});
    try {
      expect(binder.snapshot).toMatchObject({
        text: "Before", rows: [{ label: "Before" }], setText: expect.any(Function)
      });
      surface.dataModel.set("/label", "After");
      await vi.waitFor(() => expect(binder.snapshot).toMatchObject({ text: "After", rows: [{ label: "After" }] }));
      binder.snapshot.setText("From component");
      await vi.waitFor(() => expect(surface.dataModel.get("/label")).toBe("From component"));
    } finally {
      subscription.unsubscribe();
    }
  });

  it("preserves component, function and theme constraints in inline client capabilities", () => {
    const processor = new core.MessageProcessor([exampleCatalog()]);
    const catalog = processor.getClientCapabilities({ includeInlineCatalogs: true })["v0.9"].inlineCatalogs[0];
    const component = catalog.components.Example.allOf[1];
    expect(component.properties.label).toMatchObject({ type: "string", minLength: 2 });
    expect(component.properties.count).toMatchObject({ type: "integer", default: 1 });
    expect(component.required).toEqual(["component", "label"]);
    expect(component.properties.coordinates.items).toEqual([{ type: "number" }, { type: "number" }]);
    expect(component.properties.coordinates).not.toHaveProperty("prefixItems");
    expect(catalog.functions[0].parameters).toMatchObject({
      $schema: "https://json-schema.org/draft/2019-09/schema#",
      properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false
    });
    expect(catalog.theme).toEqual({ accent: { type: "string" } });
  });

  it("keeps explicit passthrough objects open and validates record values", () => {
    const schema = z.object({ values: z.record(z.string(), z.number()) }).passthrough();
    const fn = core.createFunctionImplementation({ name: "values", returnType: "object", schema },
      (args: unknown) => args);
    const catalog = new core.Catalog("catalog", [], [fn]);
    const processor = new core.MessageProcessor([catalog]);
    const parameters = processor.getClientCapabilities({ includeInlineCatalogs: true })["v0.9"]
      .inlineCatalogs[0].functions[0].parameters;
    expect(parameters.additionalProperties).not.toBe(false);
    expect(parameters.properties.values.additionalProperties).toMatchObject({ type: "number" });
    expect(schema.parse({ values: { first: 1 }, extra: "allowed" }).extra).toBe("allowed");
    expect(schema.safeParse({ values: { first: "invalid" } }).success).toBe(false);
  });

  for (const [format, utils] of [["ESM", catalogUtils], ["CJS", catalogUtilsCjs]] as const) {
    it(`preserves custom catalog constraints in the ${format} React renderer`, () => {
      const catalog = exampleCatalog();
      const result = utils.extractCatalogComponentSchemas(catalog).components.Example.allOf[1];
      expect(result.properties.label).toMatchObject({ type: "string", minLength: 2 });
      expect(result.required).toEqual(["component", "label"]);
      expect(utils.buildCatalogContextValue(catalog)).toContain('"minLength": 2');
    });
  }
});
