import type { AdminMcpServer, AdminSessionRow, AdminSkill, AdminUser, Project, Session } from "@cogniplane/shared-types";

import { ADMIN_LIVE_SECTIONS, type AdminSectionId } from "../../app/admin/admin-sections";
import { listSettingsNavigationItems } from "../../app/settings/settings-sections";
import { formatTimestamp } from "../../lib/time-format";
import { getMcpAvailability } from "../admin/mcp/admin-mcp-card.logic";
import { personHref } from "../admin/people/people-directory";

export type QuickJumpCategory = "pages" | "mySessions" | "projects" | "people" | "skills" | "connections" | "sessions";

export type QuickJumpItem = {
  id: string;
  category: QuickJumpCategory;
  title: string;
  detail: string;
  href: string;
  /** Text that is searched. Holds names, emails, and IDs only. */
  searchText: string;
};

/** Quick jump reads one page of the most recently active sessions. It never loads more. */
export const RECENT_SESSION_LIMIT = 50;
/** Most results shown per category. The count of hidden matches is shown under the category. */
export const MAX_RESULTS_PER_CATEGORY = 6;

export const CATEGORY_LABELS: Record<QuickJumpCategory, string> = {
  pages: "Pages",
  mySessions: "Your sessions",
  projects: "Projects",
  people: "People",
  skills: "Skills",
  connections: "Connections",
  sessions: "Organization sessions"
};

// Other words people use for a page, including names the page had before.
const PAGE_KEYWORDS: Record<AdminSectionId, string> = {
  overview: "home attention organization tenant slug",
  models: "providers api keys default model",
  connections: "mcp servers integrations tools github",
  skills: "library release review",
  capabilities: "agent settings approvals web access execution instructions",
  users: "people members roles access person",
  "project-owners": "ownerless orphan recover recovery assign owner projects",
  policy: "policy center rules simulator decisions monitor enforce",
  privacy: "pii personal data detection redaction",
  history: "audit changes log",
  sessions: "chats conversations investigate",
  "token-usage": "usage budget tokens cost spend",
  "message-feedback": "ratings thumbs notes",
  runtime: "runtime rollout e2b sandbox drain idle"
};

const APP_PAGES: readonly QuickJumpItem[] = [
  page("page:chat", "Chat", "Workspace", "/", "home sessions conversations"),
  page("page:projects", "Projects", "Workspace", "/projects", "folders"),
  page("page:artifacts", "Artifacts", "Workspace", "/artifacts", "files downloads"),
  page("page:archived", "Archived sessions", "Workspace", "/sessions/archived", "archive old chats")
];

const ADMIN_PAGES: readonly QuickJumpItem[] = [
  ...ADMIN_LIVE_SECTIONS.map((section) => page(`page:${section.id}`, section.label,
    "group" in section ? `Admin · ${section.group}` : "Admin", `/admin/${section.id}`, PAGE_KEYWORDS[section.id])),
  page("page:privacy-activity", "Privacy activity", "Admin · Governance", "/admin/privacy?tab=activity", "pii scans findings detections"),
  page("page:integrations", "Built-in integrations", "Admin · Setup", "/admin/connections#integrations", "github microsoft notion"),
  page("page:skill-review", "Skill submissions", "Admin · Setup", "/admin/skills?view=review", "review requests")
];

/** Pages the person can open. The area of the current page comes first. */
export function quickJumpPages(input: { isAdmin: boolean; pathname: string }): QuickJumpItem[] {
  // Read at call time: private overlays register more settings sections at startup.
  const settings = listSettingsNavigationItems().map((item) =>
    page(`page:settings-${item.id}`, item.label, "Settings", `/settings/${item.id}`, "settings preferences"));
  const admin = input.isAdmin ? ADMIN_PAGES : [];
  if (input.pathname.startsWith("/admin")) return [...admin, ...APP_PAGES, ...settings];
  if (input.pathname.startsWith("/settings")) return [...settings, ...APP_PAGES, ...admin];
  return [...APP_PAGES, ...settings, ...admin];
}

function page(id: string, title: string, detail: string, href: string, keywords: string): QuickJumpItem {
  return { id, category: "pages", title, detail, href, searchText: `${title} ${detail} ${keywords}` };
}

const ROLE_LABELS: Record<AdminUser["role"], string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function personItems(users: readonly AdminUser[]): QuickJumpItem[] {
  return users.map((user) => {
    const title = user.displayName?.trim() || user.email || "Unnamed person";
    const email = user.displayName?.trim() && user.email ? user.email : null;
    return {
      id: `person:${user.userId}`,
      category: "people",
      title,
      detail: [email, ROLE_LABELS[user.role]].filter(Boolean).join(" · "),
      href: personHref(user.userId),
      searchText: [user.displayName, user.email, user.userId].filter(Boolean).join(" ")
    };
  });
}

function skillStatus(skill: AdminSkill): string {
  if (skill.enabled) return skill.isPublished ? "Available to members" : "Available to test users";
  return skill.activeRevisionId ? "Off" : "Awaiting review";
}

// Search reads the name and ID only. Descriptions and instructions are not searched.
export function skillItems(skills: readonly AdminSkill[]): QuickJumpItem[] {
  return skills.map((skill) => ({
    id: `skill:${skill.skillId}`,
    category: "skills",
    title: skill.skillName,
    detail: `${skill.skillId} · ${skillStatus(skill)}`,
    href: `/admin/skills?skill=${encodeURIComponent(skill.skillId)}`,
    searchText: `${skill.skillName} ${skill.skillId}`
  }));
}

// Upstream URLs and auth settings are never searched or shown.
export function connectionItems(servers: readonly AdminMcpServer[]): QuickJumpItem[] {
  return servers.map((server) => ({
    id: `connection:${server.serverId}`,
    category: "connections",
    title: server.serverName,
    detail: `MCP connection · ${getMcpAvailability(server).label}`,
    href: `/admin/connections?connection=${encodeURIComponent(server.serverId)}`,
    searchText: `${server.serverName} ${server.serverId}`
  }));
}

// Session rows have no title. The person and the session ID identify a session;
// message content is never read.
export function sessionItems(sessions: readonly AdminSessionRow[], users: readonly AdminUser[] = []): QuickJumpItem[] {
  const names = new Map(users.map((user) => [user.userId, user.displayName?.trim() || null]));
  return sessions.map((session) => {
    const name = names.get(session.userId) ?? null;
    const person = name ?? session.userEmail ?? "Unknown person";
    return {
      id: `session:${session.sessionId}`,
      category: "sessions",
      title: `Session by ${person}`,
      detail: [
        `Last active ${formatTimestamp(session.lastActivityAt)}`,
        `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
        session.sessionId.slice(0, 8)
      ].join(" · "),
      href: `/admin/sessions/${encodeURIComponent(session.sessionId)}`,
      searchText: [name, session.userEmail, session.userId, session.sessionId].filter(Boolean).join(" ")
    };
  });
}

// The person's own sessions. The name is searched; message content is never read.
export function mySessionItems(sessions: readonly Session[], projects: readonly Project[] = []): QuickJumpItem[] {
  const projectNames = new Map(projects.map((project) => [project.projectId, project.name]));
  return sessions.map((session) => {
    const project = session.projectId ? projectNames.get(session.projectId) : undefined;
    return {
      id: `my-session:${session.sessionId}`,
      category: "mySessions",
      title: session.sessionName,
      detail: [project ?? "Personal", `Updated ${formatTimestamp(session.updatedAt)}`].join(" · "),
      href: `/?session=${encodeURIComponent(session.sessionId)}`,
      searchText: [session.sessionName, project, session.sessionId].filter(Boolean).join(" ")
    };
  });
}

// Project instructions are never searched.
export function projectItems(projects: readonly Project[]): QuickJumpItem[] {
  return projects.map((project) => ({
    id: `project:${project.projectId}`,
    category: "projects",
    title: project.name,
    detail: "Project",
    href: `/projects?project=${encodeURIComponent(project.projectId)}`,
    searchText: `${project.name} ${project.projectId}`
  }));
}

export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Items whose search text holds every term. Title matches rank first. */
export function matchItems(items: readonly QuickJumpItem[], query: string): QuickJumpItem[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [...items];
  const ranked: { item: QuickJumpItem; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const haystack = `${item.title} ${item.searchText}`.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return;
    const title = item.title.toLowerCase();
    const rank = title.startsWith(terms[0]) ? 0 : terms.every((term) => title.includes(term)) ? 1 : 2;
    ranked.push({ item, rank, index });
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.item);
}

/** Splits text into plain and matched parts for highlighting. */
export function highlightParts(text: string, terms: readonly string[]): { text: string; match: boolean }[] {
  const lower = text.toLowerCase();
  if (terms.length === 0 || lower.length !== text.length) return [{ text, match: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = lower.indexOf(term);
    while (from !== -1) {
      marks.fill(true, from, from + term.length);
      from = lower.indexOf(term, from + term.length);
    }
  }
  const parts: { text: string; match: boolean }[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const last = parts[parts.length - 1];
    if (last && last.match === marks[index]) last.text += text[index];
    else parts.push({ text: text[index], match: marks[index] });
  }
  return parts;
}
