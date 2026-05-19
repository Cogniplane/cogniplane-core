import { type Pool, withTenantScope } from "../lib/db.js";
import { redactSecrets } from "./redact-secrets.js";

export type ResourceType = "skill" | "mcp_server" | "integration";
export type ActivationEventType = "materialized" | "invoked" | "failed";

export type ActivationEvent = {
  resourceType: ResourceType;
  resourceId: string;
  eventType: ActivationEventType;
  metadata?: Record<string, unknown>;
};

type ActivationContext = {
  tenantId: string;
  sessionId: string;
  messageId?: string | null;
};

/**
 * Records `resource_activations` rows for skills, MCP servers, and
 * integrations. Three event types:
 *   - `materialized`: the resource was made available to the agent this turn
 *     (e.g. SKILL.md written into the workspace, MCP server listed in
 *     `codex.toml`).
 *   - `invoked`: the agent actually used it (tool call routed to that
 *     resource, MCP server received a JSON-RPC call, etc.).
 *   - `failed`: tool/MCP call attempted and errored.
 *
 * Writes are best-effort: a failure here must not break the turn. Callers
 * pass an optional logger; if absent we fall back to console.warn.
 */
export class ActivationTracker {
  constructor(
    private readonly db: Pool,
    private readonly logger: { warn: (msg: string, meta?: unknown) => void } = {
      warn: (msg, meta) => console.warn(msg, meta)
    }
  ) {}

  async recordEvent(context: ActivationContext, event: ActivationEvent): Promise<void> {
    await this.recordEvents(context, [event]);
  }

  async recordMaterialization(
    context: ActivationContext,
    resources: Array<{ resourceType: ResourceType; resourceId: string; metadata?: Record<string, unknown> }>
  ): Promise<void> {
    if (resources.length === 0) return;
    await this.recordEvents(
      context,
      resources.map((r) => ({ ...r, eventType: "materialized" as const }))
    );
  }

  async recordInvocation(
    context: ActivationContext,
    resourceType: ResourceType,
    resourceId: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.recordEvent(context, { resourceType, resourceId, eventType: "invoked", metadata });
  }

  async recordFailure(
    context: ActivationContext,
    resourceType: ResourceType,
    resourceId: string,
    error: { message: string; code?: string | number } & Record<string, unknown>
  ): Promise<void> {
    await this.recordEvent(context, {
      resourceType,
      resourceId,
      eventType: "failed",
      metadata: { error }
    });
  }

  /**
   * Per-skill adoption counts in a recent window. Returns one entry per
   * skill that has at least one row in the window — skills with no activity
   * are absent from the map (callers default to zero).
   *
   * Both numbers are *distinct sessions*, not raw event counts. Tier 1
   * telemetry writes one `materialized` row per turn the skill is offered;
   * counting raw rows would inflate a skill that just sat through a long
   * conversation. Distinct sessions matches the question the admin is
   * actually asking ("in how many sessions was this skill used").
   *
   * `invoked` rows can come from two sources — Tier 1 (tool call matched
   * `metadata.associatedToolIds`) and Tier 3 (judge said yes). We don't
   * distinguish them here: both are evidence the skill was actually used.
   */
  async countSkillActivations(
    tenantId: string,
    sinceMs: number
  ): Promise<Map<string, { invokedSessions: number; materializedSessions: number }>> {
    return this.countActivationsByResource(tenantId, "skill", sinceMs);
  }

  async countMcpServerActivations(
    tenantId: string,
    sinceMs: number
  ): Promise<Map<string, { invokedSessions: number; materializedSessions: number }>> {
    return this.countActivationsByResource(tenantId, "mcp_server", sinceMs);
  }

  private async countActivationsByResource(
    tenantId: string,
    resourceType: ResourceType,
    sinceMs: number
  ): Promise<Map<string, { invokedSessions: number; materializedSessions: number }>> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<{
        resource_id: string;
        invoked_sessions: string;
        materialized_sessions: string;
      }>(
        `
          SELECT
            resource_id,
            COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'invoked')      AS invoked_sessions,
            COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'materialized') AS materialized_sessions
          FROM resource_activations
          WHERE tenant_id = $1
            AND resource_type = $2
            AND occurred_at >= NOW() - ($3::bigint || ' milliseconds')::interval
          GROUP BY resource_id
        `,
        [tenantId, resourceType, sinceMs]
      );

      const map = new Map<string, { invokedSessions: number; materializedSessions: number }>();
      for (const row of result.rows) {
        map.set(String(row.resource_id), {
          invokedSessions: Number(row.invoked_sessions),
          materializedSessions: Number(row.materialized_sessions)
        });
      }
      return map;
    });
  }

  /**
   * Records `invoked` skill rows for every skill materialized in this
   * session whose `metadata.associatedToolIds` contains `toolName`. Looks
   * up the candidate skills directly from `resource_activations` so the
   * MCP gateway doesn't need to thread the runtime config through every
   * request — the materialization rows already carry everything we need.
   *
   * Best-effort: failures are swallowed so a tracker bug never breaks a
   * tool call. Returns the credited skill ids for diagnostics/tests.
   */
  async recordSkillInvocationsForTool(
    context: ActivationContext,
    toolName: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<string[]> {
    if (!toolName) return [];
    try {
      return await withTenantScope(this.db, context.tenantId, async (client) => {
        const result = await client.query<{ resource_id: string }>(
          `
            SELECT DISTINCT ra.resource_id
            FROM resource_activations ra
            WHERE ra.tenant_id = $1
              AND ra.session_id = $2
              AND ra.resource_type = 'skill'
              AND ra.event_type = 'materialized'
              AND ra.metadata ? 'associatedToolIds'
              AND ra.metadata -> 'associatedToolIds' @> to_jsonb($3::text)
          `,
          [context.tenantId, context.sessionId, toolName]
        );
        const skillIds = result.rows.map((row) => String(row.resource_id));
        if (skillIds.length === 0) return [];
        await this.recordEvents(
          context,
          skillIds.map((skillId) => ({
            resourceType: "skill" as const,
            resourceId: skillId,
            eventType: "invoked" as const,
            metadata: { source: "tier1_tool_match", toolName, ...(extraMetadata ?? {}) }
          }))
        );
        return skillIds;
      });
    } catch (err) {
      this.logger.warn("activation-tracker: failed to record skill invocations for tool", {
        error: err instanceof Error ? err.message : String(err),
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        toolName
      });
      return [];
    }
  }

  async recordEvents(context: ActivationContext, events: ActivationEvent[]): Promise<void> {
    if (events.length === 0) return;

    try {
      await withTenantScope(this.db, context.tenantId, async (client) => {
        // Single multi-row insert via unnest: keeps hot-path overhead low
        // even when a turn materializes a dozen resources.
        const resourceTypes: string[] = [];
        const resourceIds: string[] = [];
        const eventTypes: string[] = [];
        const metadatas: string[] = [];

        for (const event of events) {
          resourceTypes.push(event.resourceType);
          resourceIds.push(event.resourceId);
          eventTypes.push(event.eventType);
          metadatas.push(JSON.stringify(redactSecrets(event.metadata ?? {})));
        }

        await client.query(
          `
            INSERT INTO resource_activations (
              tenant_id,
              session_id,
              message_id,
              resource_type,
              resource_id,
              event_type,
              metadata
            )
            SELECT
              $1::text,
              $2::text,
              $3::text,
              t.resource_type,
              t.resource_id,
              t.event_type,
              t.metadata::jsonb
            FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[])
              AS t(resource_type, resource_id, event_type, metadata)
          `,
          [
            context.tenantId,
            context.sessionId,
            context.messageId ?? null,
            resourceTypes,
            resourceIds,
            eventTypes,
            metadatas
          ]
        );
      });
    } catch (err) {
      this.logger.warn("activation-tracker: failed to record events", {
        error: err instanceof Error ? err.message : String(err),
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        eventCount: events.length
      });
    }
  }
}

/**
 * Resolve which skills should be credited with an `invoked` event for a tool
 * call. A skill is credited when its active revision declares the tool in
 * `metadata.associatedToolIds`. Multiple skills can match — the caller emits
 * one `invoked` row per match. This is a weak signal (the agent may have
 * called the tool without following the skill's instructions); Tier 3 LLM
 * judgment is the strong signal.
 */
export function resolveSkillsForToolCall(
  toolId: string,
  skills: Array<{ id: string; associatedToolIds?: string[] }>
): string[] {
  return skills
    .filter((skill) => (skill.associatedToolIds ?? []).includes(toolId))
    .map((skill) => skill.id);
}
