// What the side panel knows about its views, as pure functions: which panel
// activities the transcript holds, which reply holds each one, the title that
// a view shows, the label that the picker gives it, and which view is selected.
// The hook reads the transcript and the surface manager and calls these.

import type { Message } from "@ag-ui/client";
import { GENERATIVE_UI_PANEL_TARGET } from "@cogniplane/shared-types";
import { GENERATIVE_UI_ACTIVITY_TYPE, type GenerativeUISurfaceContent } from "@copilotkit/shared";

/** The panel activity of a message, or undefined for any other message. */
export function panelContent(message: Message): GenerativeUISurfaceContent | undefined {
  if (message.role !== "activity" || message.activityType !== GENERATIVE_UI_ACTIVITY_TYPE) return undefined;
  const content = message.content as Partial<GenerativeUISurfaceContent> | undefined;
  return content?.target === GENERATIVE_UI_PANEL_TARGET && typeof content.surfaceId === "string"
    && Array.isArray(content.operations) ? content as GenerativeUISurfaceContent : undefined;
}

export type PanelActivity = {
  surfaceId: string;
  /** The reply of the loaded transcript that holds the activity, from 1. */
  reply: number;
  content: GenerativeUISurfaceContent;
};

/** The panel views of the transcript, oldest first, each with its reply. A
 *  reply is the run of messages between two user messages: the position of the
 *  activity in the transcript is the only source. Nothing in the content of
 *  the activity names a reply. A withdrawn preview has no operations and is
 *  not a view. */
export function panelActivities(messages: readonly Message[]): PanelActivity[] {
  const found = new Map<string, PanelActivity>();
  let reply = 0;
  let inReply = false;
  for (const message of messages) {
    if (message.role === "user") {
      inReply = false;
      continue;
    }
    if (message.role === "system" || message.role === "developer") continue;
    if (!inReply) {
      reply += 1;
      inReply = true;
    }
    const content = panelContent(message);
    if (!content || content.operations.length === 0) continue;
    // One activity holds a surface. A repeat keeps its place and takes its content.
    found.set(content.surfaceId, { surfaceId: content.surfaceId, reply: found.get(content.surfaceId)?.reply ?? reply, content });
  }
  return [...found.values()];
}

export const DEFAULT_VIEW_TITLE = "Generated view";
export const MAX_VIEW_TITLE_CHARS = 80;

// The catalog components whose `title` names the whole view.
const TITLED_ROOTS: ReadonlySet<string> = new Set(["Checklist", "ComparisonTable", "StatusSummary"]);

/** Plain text of at most `MAX_VIEW_TITLE_CHARS` characters, or undefined. The
 *  agent writes the title, so control, format and bidirectional characters go,
 *  white space collapses, and React shows the result as text. */
export function boundedTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (text === "") return undefined;
  const characters = [...text];
  return characters.length > MAX_VIEW_TITLE_CHARS ? `${characters.slice(0, MAX_VIEW_TITLE_CHARS - 1).join("").trimEnd()}…` : text;
}

/** The title of a view, from its root component as the browser built it. Only
 *  a literal `title` of a component that names its view counts. A bound or
 *  calculated title, or any other root, gives the default: the host does not
 *  guess a name. */
export function viewTitle(root: { type: string; properties: Record<string, unknown> } | undefined): string {
  if (!root || !TITLED_ROOTS.has(root.type)) return DEFAULT_VIEW_TITLE;
  return boundedTitle(root.properties.title) ?? DEFAULT_VIEW_TITLE;
}

export type ViewStatus = "ready" | "streaming" | "failed";

export type ViewEntry = {
  surfaceId: string;
  reply: number;
  title: string;
  status: ViewStatus;
};

const STATUS_NOTES: Record<ViewStatus, string> = {
  ready: "",
  streaming: " (being written)",
  failed: " (could not be shown)"
};

/** The picker label of each view, by surface id. `views` is oldest first.
 *  The label starts with the reply's position in the loaded transcript. A
 *  reload can change this position if a blocked prompt has no saved user row.
 *  A label that is still the same as another gets "(1 of 2)" in
 *  transcript order. Without reliable reply numbers (the history is cut at its
 *  start, so the count would start in the middle) only the duplicates are
 *  numbered. */
export function viewLabels(views: readonly ViewEntry[], replyNumbers: boolean): Map<string, string> {
  const base = views.map((view) => replyNumbers ? `Reply ${view.reply} · ${view.title}` : view.title);
  const totals = new Map<string, number>();
  for (const label of base) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  const latest = views.length - 1;
  views.forEach((view, index) => {
    const label = base[index]!;
    const total = totals.get(label)!;
    const position = (seen.get(label) ?? 0) + 1;
    seen.set(label, position);
    const named = total > 1 ? `${label} (${position} of ${total})` : label;
    labels.set(view.surfaceId, `${named}${index === latest ? " (latest)" : ""}${STATUS_NOTES[view.status]}`);
  });
  return labels;
}

/** The view that the user chose to look at, when it is still there and is not
 *  the latest. The latest view is the default, so choosing it, or losing the
 *  chosen one, is no choice. `available` is oldest first. */
export function effectivePin(available: readonly string[], pinned: string | undefined): string | undefined {
  if (pinned === undefined) return undefined;
  const latest = available[available.length - 1];
  return latest !== undefined && pinned !== latest && available.includes(pinned) ? pinned : undefined;
}
