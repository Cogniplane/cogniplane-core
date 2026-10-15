import { MCP_APP_MESSAGE_MAX_CHARS } from "@cogniplane/shared-types";
import { z } from "zod";

import { ToolCallError } from "../../lib/tool-call-error.js";
import { renderInteractiveUiDocument } from "./interactive-ui-document.js";
import { allRequiredObjectSchema, type ManagedToolDefinition } from "./types.js";

export const INTERACTIVE_UI_RESOURCE_URI = "ui://cogniplane/interactive-ui.html";
export const MAX_INTERACTIVE_UI_HTML_LENGTH = 64_000;

const inputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  html: z.string().min(1).max(MAX_INTERACTIVE_UI_HTML_LENGTH).refine((html) => html.trim().length > 0 && !html.includes("\u0000"))
});

function parseInput(input: Record<string, unknown>): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolCallError("Provide a title of 1 to 120 characters, a text summary of 1 to 1,000 characters, and a nonempty HTML fragment of at most 64,000 characters without NUL bytes. Shrink the widget if it is too large.");
  }
  return parsed.data;
}

export const INTERACTIVE_UI_CATALOG = [{
  name: "render_interactive_ui",
  description: "Display a completed interactive chart, diagram, calculator, or table in the chat. " +
    "Supply a short title, a useful plain-text summary, and a compact HTML fragment with inline CSS and JavaScript. " +
    "Aim for fewer than 20,000 characters. Use only data already read through authorized tools. " +
    "The widget has no network, external libraries, storage, modals, or form submission. Do not use eval or new Function. " +
    `window.cogniplane.sendMessage(text) puts a draft message of at most ${MCP_APP_MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters in the user's message box. ` +
    "The user reads and edits the draft and sends it. The call sends nothing and starts no turn. " +
    "Use CSS variables --background, --foreground, --muted, --border, and --primary to match the app theme.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      toolContextId: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", minLength: 1, maxLength: 1_000 },
      html: { type: "string", minLength: 1, maxLength: MAX_INTERACTIVE_UI_HTML_LENGTH }
    },
    required: ["title", "description", "html"],
    additionalProperties: false
  },
  appResource: {
    uri: INTERACTIVE_UI_RESOURCE_URI,
    mimeType: "text/html;profile=mcp-app",
    render: (input: Record<string, unknown>) => renderInteractiveUiDocument(parseInput(input))
  }
}] satisfies Array<Omit<ManagedToolDefinition, "handler">>;

export function createInteractiveUiTool(): ManagedToolDefinition[] {
  return [{
    ...INTERACTIVE_UI_CATALOG[0],
    outputSchema: allRequiredObjectSchema({
      title: { type: "string" },
      description: { type: "string" },
      characters: { type: "integer" }
    }),
    handler: async ({ arguments: input }) => {
      const { title, description, html } = parseInput(input);
      return { title, description, characters: html.length };
    }
  }];
}
