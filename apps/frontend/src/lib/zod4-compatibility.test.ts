// @vitest-environment jsdom
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as generativeUi from "@copilotkit/react-core/v2/generative-ui";
import { A2UI_VERSION, toJsonSchema, validateOperation } from "@copilotkit/shared/generative-ui";

const require = createRequire(import.meta.url);
const copilotRequire = createRequire(require.resolve("@copilotkit/react-core"));
const engineRequire = createRequire(copilotRequire.resolve("@copilotkit/core"));
const { buildCatalogManifest, resolveDynamicValue } = await import(pathToFileURL(copilotRequire.resolve("@copilotkit/core/generative-ui")).href);
const corePath = engineRequire.resolve("@a2ui/web_core/v0_9");
const coreRequire = createRequire(corePath);
const sharedRequire = createRequire(require.resolve("@cogniplane/shared-types"));
const { z } = sharedRequire("zod");
const core = await import(pathToFileURL(corePath).href);
const generativeUiCjs = require("@copilotkit/react-core/v2/generative-ui");

function exampleSchema() {
  return z.object({
    label: z.string().min(2),
    count: z.number().int().default(1),
    coordinates: z.tuple([z.number(), z.number()]).optional()
  });
}

function exampleCatalog(api = generativeUi) {
  return api.createGenerativeUI({
    id: "example/catalog@1",
    components: { Example: { component: () => null, props: exampleSchema() } }
  });
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

  it("validates the current wire version and rejects the previous version", () => {
    const manifest = buildCatalogManifest(exampleCatalog());
    const options = { manifest, knownSurfaces: new Set<string>() };
    const operation = { version: A2UI_VERSION, createSurface: { surfaceId: "surface", catalogId: manifest.catalogId } };
    expect(validateOperation(operation, options).ok).toBe(true);
    expect(validateOperation({ ...operation, version: "v1.0" }, options).ok).toBe(false);
    expect(validateOperation({ ...operation, createSurface: { surfaceId: 3 } }, options).ok).toBe(false);
  });

  it("resolves nested and array bindings against the current surface data model", () => {
    const surface = new core.SurfaceModel("surface", new core.Catalog("catalog", [], []));
    const context = { data: surface.dataModel, basePath: undefined };
    const props = { label: { "@path": "/label" }, rows: [{ label: { "@path": "/label" } }] };
    surface.dataModel.set("/label", "Before");
    expect(resolveDynamicValue(props, context).value).toEqual({ label: "Before", rows: [{ label: "Before" }] });
    surface.dataModel.set("/label", "After");
    expect(resolveDynamicValue(props, context).value).toEqual({ label: "After", rows: [{ label: "After" }] });
  });

  it("preserves defaults, tuple bounds and required fields through Standard Schema", () => {
    const schema = toJsonSchema(exampleSchema());
    expect(schema).toMatchObject({ properties: { label: { type: "string", minLength: 2 } } });
    expect(schema).toMatchObject({ properties: { count: { type: "integer", default: 1 } } });
    expect(schema.required).toEqual(["label"]);
    expect(schema).toMatchObject({ properties: { coordinates: { minItems: 2, maxItems: 2, items: [{ type: "number" }, { type: "number" }] } } });
    expect(exampleSchema().parse({ label: "Valid" })).toEqual({ label: "Valid", count: 1 });
  });

  it("keeps passthrough objects open and validates record values", () => {
    const schema = z.object({ values: z.record(z.string(), z.number()) }).passthrough();
    const parameters = toJsonSchema(schema);
    expect(parameters.additionalProperties).not.toBe(false);
    expect(parameters).toMatchObject({ properties: { values: { additionalProperties: { type: "number" } } } });
    expect(schema.parse({ values: { first: 1 }, extra: "allowed" }).extra).toBe("allowed");
    expect(schema.safeParse({ values: { first: "invalid" } }).success).toBe(false);
  });

  for (const [format, api] of [["ESM", generativeUi], ["CJS", generativeUiCjs]] as const) {
    it(`preserves custom catalog constraints in the ${format} React renderer`, () => {
      const catalog = api.exportA2UICatalog(exampleCatalog(api));
      const component = catalog.components.Example;
      expect(catalog.protocolVersion).toBe(A2UI_VERSION);
      expect(component.properties.label.anyOf[0]).toMatchObject({ type: "string", minLength: 2 });
      expect(component.required).toEqual(["component", "label"]);
    });
  }
});
