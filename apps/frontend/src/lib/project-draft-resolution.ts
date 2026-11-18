import type { QueryClient } from "@tanstack/react-query";

export type DraftResolution = { projectId: string; sessionId: string; draftId: string };
type Handoff = DraftResolution & { href: string };

// An identity change or a fresh document gets a new query client. Only the
// document where the editor clicked Resolve with agent can take its request.
const pending = new WeakMap<QueryClient, Handoff>();

export function requestDraftResolution(client: QueryClient, request: DraftResolution): string {
  const params = new URLSearchParams({ session: request.sessionId, resolveDraft: crypto.randomUUID() });
  const href = `/?${params}`;
  pending.set(client, { ...request, href });
  return href;
}

export function takeDraftResolution(client: QueryClient, href: string): DraftResolution | null {
  const request = pending.get(client);
  if (!request || request.href !== href) return null;
  pending.delete(client);
  return request;
}

export function cancelDraftResolution(client: QueryClient, href: string): void {
  takeDraftResolution(client, href);
}
