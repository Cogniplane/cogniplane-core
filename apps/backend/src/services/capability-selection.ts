import type { SessionCapabilitySelection } from "@cogniplane/shared-types";

export function hasUnavailableAdditions(
  next: SessionCapabilitySelection | null,
  saved: SessionCapabilitySelection | null,
  available: SessionCapabilitySelection
): boolean {
  if (!next) return false;
  return next.skillIds.some(id => !saved?.skillIds.includes(id) && !available.skillIds.includes(id)) ||
    next.connectorIds.some(id => !saved?.connectorIds.includes(id) && !available.connectorIds.includes(id));
}

export function skillSource(sourceType: string | null | undefined): "organization" | "personal" | "project" {
  return sourceType === "personal" || sourceType === "project" ? sourceType : "organization";
}

export function intersectCapabilities(
  selection: SessionCapabilitySelection | null,
  defaultsSelection: SessionCapabilitySelection | null
): SessionCapabilitySelection | null {
  if (!defaultsSelection) return selection;
  if (!selection) return defaultsSelection;
  const skills = new Set(defaultsSelection.skillIds);
  const connectors = new Set(defaultsSelection.connectorIds);
  return {
    skillIds: selection.skillIds.filter((id) => skills.has(id)),
    connectorIds: selection.connectorIds.filter((id) => connectors.has(id))
  };
}

export function isCapabilitySelected(
  selection: SessionCapabilitySelection | null | undefined,
  kind: "skill" | "connection",
  id: string
): boolean {
  return !selection || (kind === "skill" ? selection.skillIds : selection.connectorIds).includes(id);
}

export function connectionInclusion(input: {
  serverId: string;
  credentialScope: "organization" | "personal";
  allowedServerIds: readonly string[];
  selection?: SessionCapabilitySelection | null;
  executingSession: boolean;
  hasPersonalCredential: boolean;
}) {
  return {
    allowedForOrganization: input.allowedServerIds.includes(input.serverId),
    inSelection: isCapabilitySelected(input.selection, "connection", input.serverId),
    personalCredentialAccepted: !input.executingSession || input.credentialScope !== "personal" || input.hasPersonalCredential
  };
}

export function hasSkillInstructions(instructions: string | null | undefined): boolean {
  return Boolean(instructions?.trim());
}

export function acceptsPersonalCredential(status: string | undefined): boolean {
  return status === "connected";
}

export function personalServersToCheck<T extends { serverId: string; credentialScope: string }>(
  servers: readonly T[], allowedServerIds: readonly string[]
): T[] {
  return servers.filter(server => server.credentialScope === "personal" && allowedServerIds.includes(server.serverId));
}
