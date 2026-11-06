import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import { SECURITY_CHANGE_SITES } from "../../test-helpers/security-change.js";

// Every place that changes local_identities.security_version must stop the
// account's active work after the commit (security-change.ts). The functions
// that write the version (the writers) take a SecurityChange, which only
// withSecurityChange makes, and withSecurityChange calls the after-commit
// handler with the accounts that the writers recorded. This test reads the
// backend source and the private overlays, and lists every writer and every
// place that calls one. A new write of the version, a new writer, or a new
// caller fails here until it is listed in
// SECURITY_CHANGE_SITES, and security-change-sites.integration.test.ts must
// then run it against Postgres (its table is typed by that list).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PRIVATE_ROOT = path.join(REPO_ROOT, "private");

/**
 * The backend source and the source of each private overlay. The public
 * mirror has no private/ directory.
 */
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "apps/backend/src"),
  ...(existsSync(PRIVATE_ROOT)
    ? readdirSync(PRIVATE_ROOT).map((name) => path.join(PRIVATE_ROOT, name, "src")).filter((dir) => existsSync(dir))
    : [])
];

/** The SET list of each UPDATE (also `ON CONFLICT ... DO UPDATE SET`), up to its WHERE, FROM or RETURNING. */
const SET_LIST = /\bSET\b([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/gi;
/** `security_version =` as a SET target: bare, with a table alias, or quoted. `owner_security_version` is another column. */
const VERSION_TARGET = /(?:^|[\s,(.])"?security_version"?\s*=/i;

/**
 * SQL that writes the version, with any value: `security_version + 1`,
 * `1 + security_version`, `$3`, or a number. A comparison in a WHERE does not
 * count.
 */
function writesSecurityVersion(sql: string): boolean {
  if (!/\bUPDATE\b/i.test(sql)) return false;
  return [...sql.matchAll(SET_LIST)].some((match) => VERSION_TARGET.test(match[1] ?? ""));
}

/** The writers: each function whose SQL writes the version, by file from the repository root. */
const WRITERS: Record<string, string[]> = {
  "apps/backend/src/services/auth/local-account-service.ts": ["bumpSecurityVersion", "markLocalIdentityRemoved"],
  "apps/backend/src/services/auth/local-mfa-service.ts": ["LocalMfaService.applyPolicyToRoleChange", "LocalMfaService.setPolicy"]
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

type FunctionLike = ts.FunctionDeclaration | ts.MethodDeclaration;

/**
 * The name of the function that holds `node`: `Class.method`, a function
 * name, or `VERB /path` for a route handler. Anonymous callbacks (for example
 * the transaction body) count as part of the function around them.
 */
function enclosingName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      const owner = current.parent;
      const className = ts.isClassDeclaration(owner) && owner.name ? owner.name.text : "?";
      return `${className}.${current.name.text}`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isCallExpression(current.parent)) {
      const call = current.parent;
      const route = call.arguments[0];
      if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression) &&
          call.expression.expression.text === "app" && route && ts.isStringLiteral(route)) {
        return `${call.expression.name.text.toUpperCase()} ${route.text}`;
      }
    }
  }
  return null;
}

function functionNode(node: ts.Node): FunctionLike | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) return current;
  }
  return null;
}

function calledName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

type Writer = { file: string; name: string; node: FunctionLike | null; helper: boolean };

/**
 * Writers: each function whose SQL increments the version. A helper takes a
 * SecurityChange from its caller; another writer opens its own (setPolicy).
 * Sites: each function that calls a helper, and each writer that is not a
 * helper.
 */
function scan(): { writers: Writer[]; sites: Set<string> } {
  const parsed = SCAN_ROOTS.flatMap(sourceFiles).map((file) => ({
    file: path.relative(REPO_ROOT, file),
    source: ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  }));

  const writers: Writer[] = [];
  for (const { file, source } of parsed) {
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
          writesSecurityVersion(node.getText(source))) {
        const holder = functionNode(node);
        writers.push({
          file,
          name: enclosingName(node) ?? "(top level)",
          node: holder,
          helper: holder?.parameters.some((parameter) => parameter.type?.getText(source) === "SecurityChange") ?? false
        });
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const helperNames = new Set(writers.filter((writer) => writer.helper).map((writer) => writer.name.split(".").at(-1)!));
  const sites = new Set(writers.filter((writer) => !writer.helper).map((writer) => writer.name));
  for (const { source } of parsed) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calledName(node);
        const site = enclosingName(node);
        if (name && helperNames.has(name)) sites.add(site ?? "(top level)");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { writers, sites };
}

describe("security version changes", () => {
  const { writers, sites } = scan();

  test("the SQL check finds every form of a write of the version, and no comparison", () => {
    for (const sql of [
      "UPDATE local_identities SET security_version = security_version + 1 WHERE tenant_id = $1",
      "UPDATE local_identities li SET status = 'x', security_version = li.security_version + 1",
      "UPDATE local_identities SET security_version = 1 + security_version",
      "UPDATE local_identities SET security_version = $3 WHERE user_id = $2",
      "UPDATE local_identities SET security_version = 7",
      'UPDATE local_identities SET "security_version" = "security_version" + 1',
      'UPDATE local_identities li SET li."security_version" = 0',
      "INSERT INTO local_identities (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO UPDATE SET security_version = EXCLUDED.security_version"
    ]) expect(writesSecurityVersion(sql), sql).toBe(true);
    for (const sql of [
      "UPDATE local_identities SET status = $3 WHERE security_version = $4",
      "UPDATE scheduled_jobs SET owner_security_version = $14 WHERE job_id = $1",
      "SELECT security_version FROM local_identities WHERE security_version = $1",
      "SELECT set_config('app.current_tenant_id', $1, true)"
    ]) expect(writesSecurityVersion(sql), sql).toBe(false);
  });

  test("the scan reads the private overlays when they are present", () => {
    if (!existsSync(PRIVATE_ROOT)) return;
    expect(SCAN_ROOTS.some((root) => root.startsWith(PRIVATE_ROOT))).toBe(true);
  });

  test("only the listed writers write security_version", () => {
    const found: Record<string, string[]> = {};
    for (const writer of writers) (found[writer.file] ??= []).push(writer.name);
    for (const names of Object.values(found)) names.sort();
    expect(found).toEqual(WRITERS);
  });

  test("each writer records the account it changed, in a transaction that stops its work after the commit", () => {
    for (const writer of writers) {
      const label = `${writer.file} ${writer.name}`;
      expect(writer.node, label).not.toBeNull();
      const body = writer.node!.getText();
      expect(body, label).toMatch(/\bchange\.endActiveWork\(/);
      // A helper gets its SecurityChange from the caller's withSecurityChange;
      // only withSecurityChange makes one. Another writer must open its own.
      if (!writer.helper) expect(body, label).toMatch(/\b(?:this\.securityChange|withSecurityChange)\(/);
    }
  });

  test("every place that changes a security version is listed, and every listed place changes one", () => {
    expect([...sites].sort()).toEqual([...SECURITY_CHANGE_SITES].sort());
  });
});
