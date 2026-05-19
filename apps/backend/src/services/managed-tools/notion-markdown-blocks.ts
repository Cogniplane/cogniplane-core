// ── Markdown → Notion blocks (minimal, intentional) ──────────────────────────

type RichText = { type: "text"; text: { content: string; link?: { url: string } | null } };

export function richText(content: string): RichText[] {
  if (!content) return [];
  // Notion caps rich_text content at 2000 chars per chunk. Split safely.
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += 2000) {
    chunks.push(content.slice(i, i + 2000));
  }
  return chunks.map((chunk) => ({ type: "text" as const, text: { content: chunk } }));
}

/**
 * Convert markdown to a flat list of Notion blocks. Supports paragraphs, h1–h3,
 * bulleted/numbered list items, fenced code blocks, and block quotes. Rich-text
 * inline formatting (bold/italic/links) is intentionally not parsed — the agent
 * produces clean prose 99% of the time, and a minimal mapper avoids a heavy
 * dependency. Capped at NOTION_APPEND_MAX_BLOCKS by the caller.
 */
export function markdownToNotionBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const lines = markdown.split(/\r?\n/);

  let inFence = false;
  let fenceLang = "";
  let fenceLines: string[] = [];

  const flushFence = () => {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: richText(fenceLines.join("\n")),
        language: mapCodeLanguage(fenceLang)
      }
    });
    fenceLines = [];
    fenceLang = "";
  };

  for (const line of lines) {
    if (inFence) {
      if (line.startsWith("```")) {
        flushFence();
        inFence = false;
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    if (line.startsWith("```")) {
      inFence = true;
      fenceLang = line.slice(3).trim();
      continue;
    }

    if (line.trim() === "") {
      // Blank line — Notion paragraphs already separate themselves; skip.
      continue;
    }

    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: richText(line.slice(4)) }
      });
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: richText(line.slice(3)) }
      });
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: richText(line.slice(2)) }
      });
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: richText(line.slice(2)) }
      });
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: richText(line.slice(2)) }
      });
      continue;
    }
    const numbered = /^\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: richText(numbered[1]) }
      });
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(line) }
    });
  }

  if (inFence) {
    // Unterminated fence — flush whatever we collected as a code block.
    flushFence();
  }

  return blocks;
}

const NOTION_CODE_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#",
  "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran",
  "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java",
  "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
  "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix", "objective-c",
  "ocaml", "pascal", "perl", "php", "plain text", "powershell", "prolog", "protobuf",
  "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell",
  "sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly",
  "xml", "yaml"
]);

export function mapCodeLanguage(raw: string): string {
  const normalized = raw.toLowerCase().trim();
  if (!normalized) return "plain text";
  if (NOTION_CODE_LANGUAGES.has(normalized)) return normalized;
  if (normalized === "ts") return "typescript";
  if (normalized === "js") return "javascript";
  if (normalized === "py") return "python";
  if (normalized === "rb") return "ruby";
  if (normalized === "sh") return "shell";
  return "plain text";
}
