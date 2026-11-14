// Personal authority: what a turn reads or does as the acting member, with
// that member's own data or accounts. It is:
//
// - the saved memories of the member (the memory tools and the saved-memory
//   data message of each turn);
// - the member's own chats (`read_skill_corpus` reads them);
// - personal connections: integration tools whose integration has a
//   connection probe (GitHub, Notion, Jira, Microsoft 365), and proxy MCP
//   servers with `credentialScope = 'personal'`.
//
// A project turn gets none of it. Other project members write the project's
// chat history, instructions, files and skills, and every project member reads
// the replies and tool results of the chat. With personal authority, text that
// one member wrote could make the model read another member's private data
// into the shared chat. Tenant and project authority (organization MCP
// servers, tenant-enabled managed tools, project tools and skills) stay.
//
// Enforcement: the runtime config of a project session leaves these out
// (DynamicConfigService), and the MCP gateway refuses them at dispatch for a
// session that is in a project now (routes/mcp.ts), whatever the tool context
// snapshot lists. See docs/architecture/projects-and-files.md#project-chats-and-personal-data.

/** Managed tool categories (factory domain keys) that act with the member's own data. */
export const PERSONAL_MANAGED_TOOL_CATEGORIES: ReadonlySet<string> = new Set(["memory", "skill-corpus"]);

export function isPersonalManagedToolCategory(category: string | null | undefined): boolean {
  return Boolean(category && PERSONAL_MANAGED_TOOL_CATEGORIES.has(category));
}

/** A session in a project gives its turns no personal authority. */
export function sessionGivesPersonalAuthority(session: { projectId?: string | null }): boolean {
  return !session.projectId;
}
