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
 * integrations. There are three event types:
 *   - `materialized`: the resource is available to the agent in this turn.
 *     For example, skill instructions are in the system prompt.
 *   - `invoked`: the agent used the resource. For example, a tool call went to
 *     it.
 *   - `failed`: a tool or MCP call to the resource returned an error.
 *
 * Writes are best-effort. A failure must not break the turn.
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
   * Per-skill adoption counts in a recent window. Skills with no activity in
   * the window are not in the map. Callers must treat a missing skill as zero.
   *
   * Both counts are distinct sessions, not event counts. Telemetry writes one
   * `materialized` row for each turn that offers the skill, so raw rows would
   * overcount long conversations.
   *
   * An `invoked` row means a tool call through the MCP gateway matched a
   * skill's `metadata.associatedToolIds`. This is a weak signal. The agent can
   * call the tool without following the skill's instructions.
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
   * Records `invoked` skill rows for each skill materialized in this turn
   * whose `metadata.associatedToolIds` contains `toolName`. Without a message
   * id, the query matches only materializations that also have no message id.
   * The skill lookup reads `resource_activations` directly, so the MCP gateway
   * does not need the runtime config. The materialization rows already hold
   * the data it needs.
   *
   * Best-effort: the method logs failures and does not throw them, so a tracker
   * bug never breaks a tool call.
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
              AND ra.message_id IS NOT DISTINCT FROM $4::text
              AND ra.resource_type = 'skill'
              AND ra.event_type = 'materialized'
              AND ra.metadata ? 'associatedToolIds'
              AND ra.metadata -> 'associatedToolIds' @> to_jsonb($3::text)
          `,
          [context.tenantId, context.sessionId, toolName, context.messageId ?? null]
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
        // One multi-row insert with unnest keeps overhead low when a turn
        // materializes many resources.
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

