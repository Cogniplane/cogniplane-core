import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(__dirname, "..");
export const ROUTE_INDEX_MARKER = "<!-- generated route index -->";
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

// Backend and overlay sources that can register routes, tracked or new. Tests
// and test helpers start their own Fastify instances and are not part of the API.
export function routeSourceFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--",
    ":(glob)apps/backend/src/**", ":(glob)private/*-backend/src/**"], { cwd: root, encoding: "utf8" });
  return output.split("\n").filter((file) =>
    /\.ts$/.test(file) && !/\.test\.ts$/.test(file) && !/\/(test-helpers|integration)\//.test(file));
}

// The file is type-checked alone (no libraries, no imports), which is enough to
// resolve each name to its declaration in the right scope.
function checkFile(fileName: string, source: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? file : undefined),
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDirectories: () => []
  };
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest }, host);
  return { file: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

function stringValue(node: ts.Node): string | null {
  if (ts.isAsExpression(node)) return stringValue(node.expression);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ? unwrap(node.expression) : node;
}

// The values of a name at one use, from its declaration: a string const, the
// items of `for (const x of [...])` (or `[x, y]` of tuples), or a parameter
// typed as a union of string literals. Otherwise null: only run time knows it.
function valuesOf(name: ts.Identifier, checker: ts.TypeChecker): string[] | null {
  const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0];
  if (!declaration) return null;
  if (ts.isParameter(declaration)) {
    if (!declaration.type || !ts.isUnionTypeNode(declaration.type)) return null;
    const literals = declaration.type.types.map((member) =>
      ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : null);
    return literals.every((literal) => literal !== null) ? literals as string[] : null;
  }
  const variable = ts.isBindingElement(declaration) ? declaration.parent.parent : declaration;
  if (!ts.isVariableDeclaration(variable)) return null;
  const loop = variable.parent.parent;
  if (ts.isForOfStatement(loop)) {
    const list = unwrap(loop.expression);
    if (!ts.isArrayLiteralExpression(list)) return null;
    const index = ts.isBindingElement(declaration) ? (variable.name as ts.ArrayBindingPattern).elements.indexOf(declaration) : -1;
    const items = list.elements.map((element) => {
      const item = index < 0 ? element : unwrap(element);
      return index < 0 ? stringValue(item) : ts.isArrayLiteralExpression(item) && item.elements[index] ? stringValue(item.elements[index]!) : null;
    });
    return items.every((item) => item !== null) ? items as string[] : null;
  }
  const value = variable.initializer ? stringValue(variable.initializer) : null;
  return value === null ? null : [value];
}

function renderPaths(node: ts.Expression, checker: ts.TypeChecker): string[] {
  const value = stringValue(node);
  if (value !== null) return [value];
  const part = (expression: ts.Expression) =>
    (ts.isIdentifier(expression) ? valuesOf(expression, checker) : null) ?? [`{${expression.getText()}}`];
  if (ts.isIdentifier(node)) return part(node);
  if (!ts.isTemplateExpression(node)) return [];
  let paths = [node.head.text];
  for (const span of node.templateSpans) {
    paths = paths.flatMap((prefix) => part(span.expression).map((text) => prefix + text + span.literal.text));
  }
  return paths;
}

// A receiver is a Fastify instance when it is named `app` or `routes` (the
// convention here), is declared with a `FastifyInstance` type, is the callback
// parameter of `<server>.register(...)`, or is a const set to a server or to
// `Fastify(...)`. A
// registration this code cannot read throws, so the index never drops a route
// without a failed test: an unreadable path, a `route(...)` without a literal
// object, a computed method (`app["get"]`), a route-like call on a name with no
// declaration, or a `register` whose options are not a literal object without
// `prefix` (the index would show the paths without it).
const RECEIVERS = new Set(["app", "routes"]);

// A type names a Fastify instance when its text contains `FastifyInstance`, or
// when it refers to a type alias (in this file) whose type does.
function isFastifyType(type: ts.TypeNode | undefined, checker: ts.TypeChecker, seen = new Set<ts.Node>()): boolean {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  if (/\bFastifyInstance\b/.test(type.getText())) return true;
  if (!ts.isTypeReferenceNode(type)) return false;
  const alias = checker.getSymbolAtLocation(type.typeName)?.declarations?.find(ts.isTypeAliasDeclaration);
  return !!alias && isFastifyType(alias.type, checker, seen);
}

function isServer(expression: ts.Expression, checker: ts.TypeChecker): boolean | "undeclared" {
  if (!ts.isIdentifier(expression)) return false;
  if (RECEIVERS.has(expression.text)) return true;
  const declaration = checker.getSymbolAtLocation(expression)?.declarations?.[0];
  if (!declaration) return "undeclared";
  if (ts.isParameter(declaration)) {
    if (isFastifyType(declaration.type, checker)) return true;
    const callback = declaration.parent;
    const call = callback.parent;
    return (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isCallExpression(call) &&
      call.arguments[0] === callback && ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "register" && isServer(call.expression.expression, checker) === true;
  }
  if (ts.isVariableDeclaration(declaration)) {
    if (isFastifyType(declaration.type, checker)) return true;
    const initializer = declaration.initializer && unwrap(declaration.initializer);
    if (!initializer) return false;
    // `const server = Fastify()` (or `fastify(...)`): a new instance.
    if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && /^fastify$/i.test(initializer.expression.text)) return true;
    return ts.isIdentifier(initializer) && isServer(initializer, checker) === true;
  }
  return false;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const element of object.properties) {
    if (ts.isPropertyAssignment(element) && (ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)) &&
        element.name.text === name) return element.initializer;
  }
  return undefined;
}

export function listRoutes(source: string, fileName = "routes.ts"): string[] {
  const { file, checker } = checkFile(fileName, source);
  const routes: string[] = [];
  const visit = (node: ts.Node): void => {
    const where = () => `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
    if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression) &&
        isServer(node.expression.expression, checker) !== false) {
      throw new Error(`Computed route method at ${where()}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length >= 1) {
      const name = node.expression.name.text;
      const server = isServer(node.expression.expression, checker);
      const routeLike = (METHODS.has(name) && node.arguments.length >= 2) || name === "route";
      if (server === "undeclared" && routeLike) throw new Error(`Route registration on an unknown receiver at ${where()}`);
      if (server === true) {
        const options = node.arguments[1];
        if (name === "register" && options && (!ts.isObjectLiteralExpression(options) || property(options, "prefix") ||
            options.properties.some((element) => !ts.isPropertyAssignment(element) || ts.isComputedPropertyName(element.name)))) {
          throw new Error(`Route prefix is not supported at ${where()}`);
        }
        let methods: string[] = [];
        let paths: string[] = [];
        if (name === "route") {
          const object = node.arguments[0]!;
          if (!ts.isObjectLiteralExpression(object)) throw new Error(`Unsupported route registration at ${where()}`);
          const method = property(object, "method");
          const url = property(object, "url");
          methods = method && ts.isArrayLiteralExpression(method)
            ? method.elements.map((element) => stringValue(element) ?? "")
            : [method ? stringValue(method) ?? "" : ""];
          paths = url ? renderPaths(url, checker) : [];
          if (methods.includes("") || paths.length === 0) throw new Error(`Unsupported route registration at ${where()}`);
        } else if (routeLike) {
          methods = [name];
          paths = renderPaths(node.arguments[0]!, checker);
          if (paths.length === 0 || paths.some((routePath) => !/^[/{]/.test(routePath))) {
            throw new Error(`Unsupported route registration at ${where()}`);
          }
        }
        // `admin`: the handler is wrapped in `withAdmin` (owners and admins).
        const admin = node.arguments.slice(1).some((argument) =>
          ts.isCallExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === "withAdmin");
        for (const method of methods) {
          for (const routePath of paths) routes.push(`${method.toUpperCase()} \`${routePath}\`${admin ? " (admin)" : ""}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return routes;
}

// Keys of STEP_UP_ROUTES, as "METHOD /path".
async function stepUpRoutes(): Promise<Set<string>> {
  const source = await readFile(path.join(root, "apps/backend/src/services/auth/step-up-routes.ts"), "utf8");
  return new Set([...source.matchAll(/^ {2}"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]+)":/gm)].map((match) => match[1]!));
}

// One heading per source file, linked from docs/, then one route per line. The
// label drops the common `apps/backend/src/` prefix; the link keeps the path.
export async function renderRouteIndex(): Promise<string> {
  const stepUp = await stepUpRoutes();
  if (stepUp.size === 0) throw new Error("No STEP_UP_ROUTES keys found");
  const tagged = new Set<string>();
  const sections: string[] = [];
  for (const file of routeSourceFiles().sort()) {
    const routes = listRoutes(await readFile(path.join(root, file), "utf8"), file).map((route) => {
      const key = route.replace(/ \(admin\)$/, "").replace(/`/g, "");
      if (!stepUp.has(key)) return route;
      tagged.add(key);
      return route.endsWith(" (admin)") ? route.replace(/ \(admin\)$/, " (admin, step-up)") : `${route} (step-up)`;
    });
    const label = file.replace(/^apps\/backend\/src\//, "");
    if (routes.length > 0) sections.push(`## [${label}](../${file})\n\n${routes.map((route) => `- ${route}`).join("\n")}`);
  }
  const untagged = [...stepUp].filter((key) => !tagged.has(key));
  if (untagged.length > 0) throw new Error(`STEP_UP_ROUTES keys with no registered route: ${untagged.join(", ")}`);
  return sections.join("\n\n") + "\n";
}

export async function generateRouteIndex(check = false): Promise<void> {
  const target = path.join(root, "docs/routes.md");
  const current = await readFile(target, "utf8");
  const marker = current.indexOf(ROUTE_INDEX_MARKER);
  if (marker < 0) throw new Error("Route index marker is missing");
  const next = current.slice(0, marker) + ROUTE_INDEX_MARKER + "\n\n" + await renderRouteIndex();
  if (check) {
    if (next !== current) throw new Error("Route index is stale. Run pnpm exec tsx scripts/generate-route-index.ts");
  } else {
    await writeFile(target, next);
  }
}

if (require.main === module) {
  generateRouteIndex(process.argv.includes("--check")).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
