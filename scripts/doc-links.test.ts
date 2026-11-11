import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// Every relative Markdown link must name a file that exists, and a `#anchor`
// on a Markdown file must name one of its headings (GitHub slug rules).
const root = path.resolve(__dirname, "..");

function trackedMarkdown(): string[] {
  const output = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" });
  return output.split("\n").filter((file) => file && existsSync(path.join(root, file)));
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "");
}

// GitHub's rules: link text only, lower case, keep letters, marks, numbers,
// `_`, `-` and spaces (in any script), spaces become `-`, and a repeated slug
// gets `-1`, `-2`, ...
export function slug(heading: string): string {
  return heading.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
}

function anchors(file: string): Set<string> {
  const text = withoutCode(readFileSync(path.join(root, file), "utf8"));
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const match of text.matchAll(/^#+\s+(.*)$/gm)) {
    const base = slug(match[1]!);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

it("builds anchors like GitHub", () => {
  expect(slug("Add a `render_ui` card")).toBe("add-a-render_ui-card");
  expect(slug("Sécurité & accès")).toBe("sécurité--accès");
  expect(slug("[Routes](../x.ts)")).toBe("routes");
});

it("keeps relative documentation links and anchors valid", () => {
  const broken: string[] = [];
  for (const file of trackedMarkdown()) {
    const text = withoutCode(readFileSync(path.join(root, file), "utf8"));
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [linkPath, anchor] = target.split("#");
      const resolved = linkPath ? path.normalize(path.join(path.dirname(file), linkPath)) : file;
      if (!existsSync(path.join(root, resolved))) {
        broken.push(`${file}: missing ${target}`);
      } else if (anchor && resolved.endsWith(".md") && !anchors(resolved).has(anchor)) {
        broken.push(`${file}: missing anchor ${target}`);
      }
    }
  }
  expect(broken).toEqual([]);
});

// Backticked file references must name files that exist, so docs fail CI when
// code moves. Paths may be repository-relative, relative to a package source
// root (`services/...`, `lib/...`), or bare file names. Globs and placeholders
// are skipped; `.env` files are created by the user.
const SOURCE_ROOTS = ["", "apps/backend/src", "apps/frontend/src", "apps/backend", "apps/frontend", "packages/shared-types/src"];
const REFERENCE = /`([^`\s]+)`/g;
const PLACEHOLDER = /[*<>{}…:]|\.\.\./;
const REPO_PREFIX = /^(apps|packages|docs|scripts|docker|private|\.github)\//;
const SOURCE_PREFIX = /^(services|routes|lib|components|hooks|app|domain|integration)\//;
// A bare file name must name one file. These names mean the kind of file.
const GENERIC_FILE_NAMES = new Set(["page.tsx", "package.json"]);
const FILE_NAME = /^[^/]+\.(ts|tsx|sql|mjs|json|jsonc|yml|yaml)$/;

it("names only files that exist in backticked references", () => {
  const trackedNames = new Map<string, number>();
  const trackedFiles = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const file of execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)) {
    trackedNames.set(path.basename(file), (trackedNames.get(path.basename(file)) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const file of trackedMarkdown()) {
    const text = withoutCode(readFileSync(path.join(root, file), "utf8"));
    for (const match of text.matchAll(REFERENCE)) {
      const reference = match[1]!.split("#")[0]!.replace(/[/.,]+$/, "");
      if (PLACEHOLDER.test(reference) || /(^|\/)\.env(\.local)?$/.test(reference)) continue;
      if (REPO_PREFIX.test(reference) || SOURCE_PREFIX.test(reference)) {
        // A path relative to a source root (`lib/db.ts`) must name one file
        // across the packages, so `lib/` cannot mean two places.
        const candidates = SOURCE_ROOTS.flatMap((sourceRoot) => ["", ".ts", ".tsx"].map((extension) => path.join(sourceRoot, reference + extension)))
          .filter((candidate) => existsSync(path.join(root, candidate)));
        const filesFound = new Set(candidates.filter((candidate) => statSync(path.join(root, candidate)).isFile()));
        if (candidates.length === 0) missing.push(`${file}: ${reference}`);
        else if (filesFound.size > 1) missing.push(`${file}: ${reference} (ambiguous: ${[...filesFound].join(", ")})`);
      } else if (reference.includes("/") && /\.(ts|tsx|sql|mjs|json|ya?ml)$/.test(reference)) {
        // Any other partial path must end exactly one tracked file.
        const matches = trackedFiles.filter((tracked) => tracked === reference || tracked.endsWith(`/${reference}`));
        if (matches.length !== 1) missing.push(`${file}: ${reference} (${matches.length} files end with it)`);
      } else if (FILE_NAME.test(reference) && (trackedNames.get(reference) ?? 0) !== 1 && !GENERIC_FILE_NAMES.has(reference)) {
        missing.push(`${file}: ${reference} (${trackedNames.has(reference) ? "ambiguous: give its directory" : "missing"})`);
      }
    }
  }
  expect(missing).toEqual([]);
});

// Code names in backticks must exist in the code, and `METHOD /path` must be a
// registered route, so docs fail CI when code is renamed. Checked names:
// SCREAMING_CASE, camelCase, PascalCase with an inner capital, snake_case, and
// dotted names (`Class.method`: each part). The check proves that the name
// exists somewhere in the code, not in the file that the doc cites. Path
// parameter names must match the route; a trailing `/*`
// matches any route under that prefix. A code span may
// wrap over two lines. Fenced `ts` and `sql` blocks are checked too, without
// comments and string literals; example names contain `myint` (overlays.md).
// Names that production code does not define, listed on purpose: PostgreSQL,
// Docker Compose and Node.js runtime names, the upstream sample code in
// mcp-proxy-signature.md, and test constants that data.md cites with their
// test file.
const EXTERNAL_NAMES = new Set(["max_connections", "pg_dump", "pg_cancel_backend", "pg_stat_activity", "stop_grace_period", "UV_THREADPOOL_SIZE", "highWater", "rawBody", "WRITE_PATHS", "GLOBAL_TABLES"]);
// Legal texts quote third-party names verbatim; the route index is checked by
// its own tests. The configuration reference is checked: its table names only
// schema variables.
const NOT_CHECKED = new Set(["docs/routes.md", "THIRD_PARTY_NOTICES.md", "CLA.md", "CODE_OF_CONDUCT.md", "COMMERCIAL.md"]);
const CODE_NAME = /^(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)$/;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/[^\s?]*)/;

function codeWords(): Set<string> {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n").filter((file) => /\.(ts|tsx|js|mjs|sql|ya?ml|json|sh|css|toml)$|Makefile$|Dockerfile$/.test(file) &&
      !file.endsWith("pnpm-lock.yaml") && !/\.test\.tsx?$|test-helpers\/|\/integration\/|__fixtures__/.test(file) &&
      existsSync(path.join(root, file)));
  // Comments do not count: a name that survives only in a comment is stale.
  const withoutComments = (file: string, text: string) => /\.(ts|tsx|js|mjs|css)$/.test(file)
    ? text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
    : file.endsWith(".sql") ? text.replace(/--[^\n]*/g, "")
      : /\.(ya?ml|sh|toml)$|Makefile$|Dockerfile$/.test(file) ? text.replace(/(^|\s)#[^\n]*/g, "$1") : text;
  const words = new Set<string>();
  for (const file of files) {
    const text = withoutComments(file, readFileSync(path.join(root, file), "utf8"));
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) words.add(match[0]);
  }
  return words;
}

it("names only code symbols and routes that exist", () => {
  const words = codeWords();
  // Parameter names must match the code; only run-time parts (`{name}`) are free.
  const normalize = (routePath: string) => routePath.replace(/\{[^}]+\}/g, ":param");
  const routes = new Set([...readFileSync(path.join(root, "docs/routes.md"), "utf8").matchAll(/(GET|POST|PUT|PATCH|DELETE) `([^`]+)`/g)]
    .map((match) => `${match[1]} ${normalize(match[2]!)}`));
  const missing: string[] = [];
  for (const file of trackedMarkdown().filter((name) => !NOT_CHECKED.has(name))) {
    const text = withoutCode(readFileSync(path.join(root, file), "utf8"));
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const span = match[1]!.replace(/\s+/g, " ").trim();
      const route = ROUTE.exec(span);
      if (route) {
        const wanted = `${route[1]} ${normalize(route[2]!)}`;
        const found = wanted.endsWith("/*")
          ? [...routes].some((known) => known.startsWith(wanted.slice(0, -1)))
          : routes.has(wanted);
        if (!found) missing.push(`${file}: ${span}`);
        continue;
      }
      const name = span.replace(/\(\)$/, "");
      const dotted = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(name) && !FILE_NAME.test(name) && !/\.(md|env|example|local)$/.test(name);
      const parts = dotted ? name.split(".") : CODE_NAME.test(name) ? [name] : [];
      for (const part of parts) {
        if (!words.has(part) && !EXTERNAL_NAMES.has(part)) missing.push(`${file}: ${name}`);
      }
    }
  }
  for (const file of trackedMarkdown().filter((name) => !NOT_CHECKED.has(name))) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const block of text.matchAll(/```(?:ts|typescript|sql)\n([\s\S]*?)```/g)) {
      const code = block[1]!.replace(/\/\/[^\n]*|--[^\n]*|"[^"\n]*"|'[^'\n]*'/g, "");
      for (const match of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        const name = match[0];
        if (CODE_NAME.test(name) && !/myint/i.test(name) && !words.has(name) && !EXTERNAL_NAMES.has(name)) {
          missing.push(`${file} (code block): ${name}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
});

// A code name followed by its file, as in `withAdmin` (`lib/admin.ts`), must
// appear in that file, so a move of the symbol fails CI.
it("finds each code name in the file that the doc cites for it", () => {
  const trackedFiles = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n");
  const resolve = (reference: string) => {
    const direct = SOURCE_ROOTS.flatMap((sourceRoot) => ["", ".ts", ".tsx"].map((extension) => path.join(sourceRoot, reference + extension)))
      .filter((candidate) => existsSync(path.join(root, candidate)) && !candidate.endsWith("/"));
    return direct.length > 0 || reference.includes("/") ? direct : trackedFiles.filter((file) => path.basename(file) === reference);
  };
  const missing: string[] = [];
  let checked = 0;
  for (const file of trackedMarkdown().filter((name) => !NOT_CHECKED.has(name))) {
    const text = withoutCode(readFileSync(path.join(root, file), "utf8")).replace(/\s+/g, " ");
    for (const match of text.matchAll(/`([A-Za-z_][\w.]*)(?:\(\))?` ?\(`([^`\s]+\.(?:ts|tsx|sql|mjs))`/g)) {
      const name = match[1]!;
      if (!CODE_NAME.test(name.split(".").at(-1)!) && !name.includes(".")) continue;
      const files = resolve(match[2]!).filter((candidate) => existsSync(path.join(root, candidate)));
      if (files.length === 0) continue;
      checked += 1;
      const symbol = new RegExp(`\\b${name.split(".").at(-1)!}\\b`);
      if (!files.some((candidate) => symbol.test(readFileSync(path.join(root, candidate), "utf8")))) {
        missing.push(`${file}: ${name} is not in ${match[2]}`);
      }
    }
  }
  expect(checked).toBeGreaterThan(20);
  expect(missing).toEqual([]);
});

// `make <target>` and `pnpm [--filter <package>] <script>` in code spans and
// shell blocks must name a Makefile target or a package.json script.
const PNPM_BUILTINS = new Set(["exec", "install", "add", "audit", "dlx", "why", "run"]);

it("names only Make targets and package scripts that exist", () => {
  const targets = new Set([...readFileSync(path.join(root, "Makefile"), "utf8").matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((match) => match[1]!));
  const packageFiles = execFileSync("git", ["ls-files", "package.json", "*/package.json"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const scripts = new Map<string, Set<string>>();
  for (const file of packageFiles) {
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { name?: string; scripts?: Record<string, string> };
    scripts.set(file === "package.json" ? "" : manifest.name ?? file, new Set(Object.keys(manifest.scripts ?? {})));
  }
  const missing: string[] = [];
  let checked = 0;
  for (const file of trackedMarkdown().filter((name) => !NOT_CHECKED.has(name))) {
    const text = readFileSync(path.join(root, file), "utf8");
    const shellLines = [...text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)].flatMap((match) => match[1]!.split("\n"));
    const spans = [...withoutCode(text).matchAll(/`([^`]+)`/g)].map((match) => match[1]!.replace(/\s+/g, " "));
    for (const command of [...shellLines, ...spans].map((line) => line.trim().replace(/^.*?\b(?=(make|pnpm) )/, ""))) {
      const make = /^make ([a-z0-9-]+)/.exec(command);
      const pnpm = /^pnpm (?:--filter ([@\w/.-]+) )?([a-z][\w:.-]*)/.exec(command);
      if (make) {
        checked += 1;
        if (!targets.has(make[1]!)) missing.push(`${file}: ${command}`);
      } else if (pnpm && !PNPM_BUILTINS.has(pnpm[2]!)) {
        checked += 1;
        if (!scripts.get(pnpm[1] ?? "")?.has(pnpm[2]!)) missing.push(`${file}: ${command}`);
      }
    }
  }
  expect(checked).toBeGreaterThan(10);
  expect(missing).toEqual([]);
});

// `Admin > X` and `Settings > X` must start with a label that the UI shows:
// the admin sections, the settings sections, and the overlay settings sections.
it("names only admin and settings pages that the UI shows", () => {
  const labels = (file: string) => [...readFileSync(path.join(root, file), "utf8").matchAll(/label: "([^"]+)"/g)].map((match) => match[1]!);
  const overlayFiles = execFileSync("git", ["ls-files", "private/*-frontend/src/bootstrap/*.tsx"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const pages = {
    Admin: labels("apps/frontend/src/app/admin/admin-sections.ts"),
    Settings: [...labels("apps/frontend/src/app/settings/settings-sections.ts"), ...overlayFiles.flatMap(labels)]
  };
  const missing: string[] = [];
  for (const file of trackedMarkdown().filter((name) => !NOT_CHECKED.has(name))) {
    const text = readFileSync(path.join(root, file), "utf8").replace(/\s+/g, " ");
    for (const match of text.matchAll(/\b(Admin|Settings) > ([^`(),.;:]+)/g)) {
      const rest = match[2]!;
      if (!pages[match[1] as "Admin" | "Settings"].some((label) => rest === label || rest.startsWith(`${label} `))) {
        missing.push(`${file}: ${match[1]} > ${rest}`);
      }
    }
  }
  expect(missing).toEqual([]);
});

// Code comments that cite a doc (`docs/x.md`, optionally `, "Heading"`) must
// name a file and heading that exist. Applied migrations cannot change.
it("keeps doc pointers in code comments valid", () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n")
    .filter((file) => /\.(ts|tsx|mjs|sql|ya?ml|sh)$|Makefile$|Dockerfile$|\.example$/.test(file) &&
      !/\.test\.tsx?$|test-helpers\/|\/db\/migrations\//.test(file) && existsSync(path.join(root, file)));
  const broken: string[] = [];
  let checked = 0;
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8").replace(/\n\s*(\/\/|\*|#|--)\s*/g, " ");
    for (const match of text.matchAll(/(docs\/[\w./-]+\.md)(?:#([a-z0-9-]+))?(?:,? "([^"]+)")?/g)) {
      checked += 1;
      const [, doc, anchor, heading] = match;
      if (!existsSync(path.join(root, doc!))) {
        broken.push(`${file}: ${doc}`);
        continue;
      }
      for (const wanted of [anchor, heading && slug(heading)]) {
        if (wanted && !anchors(doc!).has(wanted)) broken.push(`${file}: ${doc} ${wanted}`);
      }
    }
  }
  expect(checked).toBeGreaterThan(20);
  expect(broken).toEqual([]);
});

// models.md lists every provider key variable, so a new provider fails CI
// until the doc names it.
it("documents every model provider", () => {
  const primitives = readFileSync(path.join(root, "packages/shared-types/src/primitives.ts"), "utf8");
  const providers = /MODEL_PROVIDERS = \[([^\]]+)\]/.exec(primitives)?.[1]?.match(/"[a-z]+"/g)?.map((name) => name.slice(1, -1)) ?? [];
  const models = readFileSync(path.join(root, "docs/architecture/models.md"), "utf8");
  expect(providers.length).toBeGreaterThan(0);
  expect(providers.filter((provider) => !models.includes(`\`${provider.toUpperCase()}_API_KEY\``))).toEqual([]);
});

// A heading has a blank line before it, so every renderer and the anchor
// slugs see it as a heading.
it("puts a blank line before each heading", () => {
  const missing: string[] = [];
  for (const file of trackedMarkdown().filter((name) => !NOT_CHECKED.has(name))) {
    const lines = readFileSync(path.join(root, file), "utf8").split("\n");
    let fence = false;
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("```")) fence = !fence;
      if (!fence && index > 0 && /^#{1,6} /.test(line) && lines[index - 1]!.trim() !== "") missing.push(`${file}:${index + 1}`);
    });
  }
  expect(missing).toEqual([]);
});

// The shutdown numbers in the docs and in compose.yaml follow the backend's
// own deadline: the stated deadline matches it, and every stop timeout is
// longer.
it("keeps the shutdown numbers in step with SHUTDOWN_DEADLINE_MS", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const deadlineMs = Number(/SHUTDOWN_DEADLINE_MS = ([\d_]+)/.exec(read("apps/backend/src/server.ts"))?.[1]?.replace(/_/g, ""));
  expect(deadlineMs).toBeGreaterThan(0);
  const stated = Number(/`SHUTDOWN_DEADLINE_MS` \((\d+) seconds\)/.exec(read("docs/operations.md").replace(/\s+/g, " "))?.[1]);
  expect(stated * 1000).toBe(deadlineMs);
  const timeouts = [
    Number(/stop_grace_period: (\d+)s/.exec(read("compose.yaml"))?.[1]),
    Number(/--stop-timeout (\d+)/.exec(read("docs/self-hosting.md"))?.[1]),
    Number(/termination grace of at least (\d+) seconds/.exec(read("docs/operations.md").replace(/\s+/g, " "))?.[1])
  ];
  expect(timeouts.every((seconds) => seconds * 1000 > deadlineMs)).toBe(true);
});

// Every NEXT_PUBLIC_* variable that the frontend reads is in its variable table.
it("documents every public frontend variable", () => {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "apps/frontend"], { cwd: root, encoding: "utf8" })
    .split("\n").filter((file) => /\.(ts|tsx|mjs)$/.test(file) && existsSync(path.join(root, file)));
  const used = new Set(files.flatMap((file) =>
    [...readFileSync(path.join(root, file), "utf8").matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+/g)].map((match) => match[0])));
  const documented = readFileSync(path.join(root, "docs/architecture/frontend.md"), "utf8");
  expect(used.size).toBeGreaterThan(0);
  expect([...used].filter((name) => !documented.includes(`\`${name}\``))).toEqual([]);
});

// apps/frontend/DESIGN.md mirrors the color tokens of globals.css for design
// tools. Every color in its frontmatter must exist in globals.css, and every
// component must name a defined color.
it("keeps the DESIGN.md color tokens in globals.css", () => {
  const design = readFileSync(path.join(root, "apps/frontend/DESIGN.md"), "utf8");
  const frontmatter = design.split("---")[1] ?? "";
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "");
  const css = normalize(readFileSync(path.join(root, "apps/frontend/src/app/globals.css"), "utf8"));
  const colors = new Map([...frontmatter.matchAll(/^ {2}([\w-]+): "(#[0-9a-f]{6}|rgba\([^)]*\))"$/gim)]
    .map((match) => [match[1]!, normalize(match[2]!)]));
  expect(colors.size).toBeGreaterThan(0);
  expect([...colors.values()].filter((color) => !css.includes(color))).toEqual([]);
  // The role table maps each frontmatter color to the CSS variable that has its value.
  const cssVariables = [...css.matchAll(/(--[\w-]+):([^;]+);/g)].map((match) => [match[1]!, match[2]!] as const);
  const roles = [...design.matchAll(/^\| `([\w-]+)` \| `(--[\w-]+)` \|$/gm)].map((match) => [match[1]!, match[2]!] as const);
  expect(roles.length).toBe(colors.size);
  expect(roles.filter(([name, variable]) =>
    !cssVariables.some(([cssName, value]) => cssName === variable && value === colors.get(name)))).toEqual([]);
  const references = [...frontmatter.matchAll(/\{colors\.([\w-]+)\}/g)].map((match) => match[1]!);
  expect(references.filter((name) => !colors.has(name))).toEqual([]);
});
