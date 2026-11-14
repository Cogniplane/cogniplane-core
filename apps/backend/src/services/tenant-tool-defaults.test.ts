import { afterEach, expect, test } from "vitest";

import { buildAppDependencies } from "../app-dependencies.js";
import { Pool } from "../lib/db.js";
import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import {
  buildDefaultTenantSettingsInput,
  DEFAULT_TENANT_TOOL_IDS,
  LEGACY_DEFAULT_TOOL_ID_ALIASES,
  OFF_BY_DEFAULT_TENANT_TOOL_IDS
} from "./tenant-settings-store.js";

// Each tenant-configurable tool of the real catalog needs a rollout decision:
// on for a new tenant (DEFAULT_TENANT_TOOL_IDS) or off (OFF_BY_DEFAULT_...).
// A catalog addition without one fails here. Existing tenants keep their
// stored list either way; see "Add a core managed tool" in
// docs/architecture/tools.md for the backfill step.

const pools: Pool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

function configurableTools(): string[] {
  const db = new Pool();
  pools.push(db);
  const deps = buildAppDependencies({ db, config: createTestConfig(), logger: createSilentLogger() });
  return deps.managedToolCatalog.listTenantConfigurable().map((entry) => entry.name).sort();
}

const aliases = new Set<string>(LEGACY_DEFAULT_TOOL_ID_ALIASES);
const defaultTools = DEFAULT_TENANT_TOOL_IDS.filter((id) => !aliases.has(id));
const offByDefault = Object.keys(OFF_BY_DEFAULT_TENANT_TOOL_IDS);

test("each tenant-configurable catalog tool is on or off by default, never neither", () => {
  expect([...defaultTools, ...offByDefault].sort()).toEqual(configurableTools());
});

test("no tool is both on and off by default, and the default list has no duplicates", () => {
  expect(defaultTools.filter((id) => offByDefault.includes(id))).toEqual([]);
  expect(new Set(DEFAULT_TENANT_TOOL_IDS).size).toBe(DEFAULT_TENANT_TOOL_IDS.length);
});

test("the legacy alias is not a tool, and stays in the defaults of a new tenant", () => {
  const configurable = configurableTools();
  for (const alias of LEGACY_DEFAULT_TOOL_ID_ALIASES) {
    expect(configurable).not.toContain(alias);
    expect(buildDefaultTenantSettingsInput().enabledToolIds).toContain(alias);
  }
});

test("the current choices are kept: render_interactive_ui is off by default", () => {
  expect(offByDefault).toEqual(["render_interactive_ui"]);
  expect(buildDefaultTenantSettingsInput().enabledToolIds).toEqual(DEFAULT_TENANT_TOOL_IDS);
});
