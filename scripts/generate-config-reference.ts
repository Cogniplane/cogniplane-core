import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { envSchema } from "../apps/backend/src/config.js";

const root = path.resolve(__dirname, "..");
export const CONFIG_TABLE_MARKER = "<!-- generated configuration table -->";

// Read declarations, never deployment environment values or .env files.
export function renderConfigTable(source: string): string {
  const file = ts.createSourceFile("config.ts", source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const schema = declarations.get("envSchema");
  if (!schema || !ts.isCallExpression(schema) || !ts.isObjectLiteralExpression(schema.arguments[0])) {
    throw new Error("Cannot find the environment schema object");
  }
  function describe(expression: ts.Expression): string[] {
    if (ts.isIdentifier(expression)) {
      if (expression.text === "booleanFromEnvSchema") return ["boolean"];
      if (expression.text === "jwtVerificationKeysSchema") return ["JSON object of key IDs to secrets of at least 32 characters"];
      const declaration = declarations.get(expression.text);
      if (declaration) return describe(declaration);
    }
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
      throw new Error(`Unsupported configuration validator: ${expression.getText(file)}`);
    }
    const call = expression.expression;
    const name = call.name.text;
    const args = expression.arguments.map(arg => arg.getText(file));
    if (["string", "number"].includes(name)) return [name];
    if (name === "enum") return [`one of ${args[0]}`];
    const parent = describe(call.expression);
    if (["default", "optional", "trim"].includes(name)) return parent;
    const labels: Record<string, string> = {
      int: "integer", positive: "> 0", nonnegative: ">= 0", url: "URL",
      min: `minimum ${args[0]}`, max: `maximum ${args[0]}`,
      regex: `matches ${args[0]}`, refine: "additional validation in source"
    };
    if (!(name in labels)) throw new Error(`Undocumented validator: ${name}`);
    return [...parent, labels[name]];
  }
  const cell = (value: string) => value.replaceAll("|", "&#124;").replaceAll("\n", " ");
  const lines = ["| Variable | Accepted value | Default when unset |", "| --- | --- | --- |"];
  const documented = new Set<string>();
  for (const property of schema.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error("Unsupported schema property");
    const key = property.name.text as keyof typeof envSchema.shape;
    const parsed = envSchema.shape[key].safeParse(undefined);
    if (!parsed.success) throw new Error(`Cannot determine default for ${key}`);
    let defaultValue = parsed.data === undefined ? "unset" : JSON.stringify(parsed.data);
    if (typeof parsed.data === "string" && parsed.data.startsWith(os.tmpdir() + path.sep)) {
      defaultValue = JSON.stringify("<system-temp>/" + path.relative(os.tmpdir(), parsed.data).split(path.sep).join("/"));
    }
    const line = file.getLineAndCharacterOfPosition(property.getStart(file)).line + 1;
    lines.push(`| [\`${key}\`](../apps/backend/src/config.ts#L${line}) | ${cell(describe(property.initializer).join(", "))} | \`${cell(defaultValue)}\` |`);
    documented.add(key);
  }
  if (documented.size !== Object.keys(envSchema.shape).length) throw new Error("Incomplete configuration reference");
  return lines.join("\n") + "\n";
}

export async function generateConfigReference(check = false): Promise<void> {
  const target = path.join(root, "docs/CONFIGURATION.md");
  const current = await readFile(target, "utf8");
  const marker = current.indexOf(CONFIG_TABLE_MARKER);
  if (marker < 0) throw new Error("Configuration table marker is missing");
  const source = await readFile(path.join(root, "apps/backend/src/config.ts"), "utf8");
  const next = current.slice(0, marker) + CONFIG_TABLE_MARKER + "\n\n" + renderConfigTable(source);
  if (check) {
    if (next !== current) throw new Error("Configuration reference is stale. Run pnpm exec tsx scripts/generate-config-reference.ts");
  } else {
    await writeFile(target, next);
  }
}

if (require.main === module) {
  generateConfigReference(process.argv.includes("--check")).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
