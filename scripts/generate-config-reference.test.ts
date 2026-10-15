import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateConfigReference, renderConfigTable } from "./generate-config-reference.js";

const configPath = path.resolve(__dirname, "../apps/backend/src/config.ts");
afterEach(() => vi.unstubAllEnvs());

it("keeps every schema key, constraint and default current in the operator reference", async () => {
  await expect(generateConfigReference(true)).resolves.toBeUndefined();
});

it("documents schema defaults without reading deployment values", async () => {
  vi.stubEnv("DATABASE_URL", "postgres://do-not-copy-this-secret@private-host/db");
  vi.stubEnv("PII_RETENTION_KEK", "do-not-copy-this-key");
  const table = renderConfigTable(await readFile(configPath, "utf8"));
  expect(table).not.toContain("do-not-copy");
  expect(table).toContain('`"<system-temp>/cogniplane-core-artifacts"`');
  expect(table).toContain("JSON object of key IDs to secrets of at least 32 characters");
});

it("rejects validators it cannot describe instead of silently omitting their constraints", () => {
  const source = "const envSchema = z.object({ API_PORT: z.number().multipleOf(2) });";
  expect(() => renderConfigTable(source)).toThrow("Undocumented validator: multipleOf");
});
