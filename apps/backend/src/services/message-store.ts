
import { type Pool, withTenantScope } from "../lib/db.js";
import { uuidv7 } from "../lib/uuid.js";
import { isoTimestamp } from "../lib/db-mappers.js";

export type ToolResultRecord = {
  id: number;
  toolResultId: string;
  messageId: string;
  sessionId: string;
  userId: string;
  kind: "command" | "mcp";
  title: string;
  status: "in_progress" | "completed" | "failed" | "declined";
  command: string | null;
  cwd: string | null;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TokenUsageRecord = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type MessageFeedbackRating = "thumbs_up" | "thumbs_down";

export type MessagePiiDetail = {
  status?: "blocked" | "transformed" | "detected" | "scanned" | "failed";
  modeApplied?: "off" | "detect" | "block" | "transform";
  scanRunId?: string;
  transformed?: boolean;
  blockReason?: string;
};

export type MessageDetail = {
  pii?: MessagePiiDetail;
  [key: string]: unknown;
};

export type MessageRecord = {
  id: number;
  messageId: string;
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  status: "pending" | "streaming" | "completed" | "error" | "interrupted";
  content: string;
  reasoningContent: string;
  planContent: string;
  tokenUsage: TokenUsageRecord | null;
  modelName: string | null;
  costUsd: number | null;
  feedbackRating: MessageFeedbackRating | null;
  detail: MessageDetail;
  toolResults: ToolResultRecord[];
  createdAt: string;
  updatedAt: string;
};

function mapToolResult(row: Record<string, unknown>): ToolResultRecord {
  return {
    id: Number(row.id),
    toolResultId: String(row.tool_result_id),
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    kind: row.kind === "mcp" ? "mcp" : "command",
    title: String(row.title ?? ""),
    status:
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "declined"
        ? row.status
        : "in_progress",
    command: row.command_text ? String(row.command_text) : null,
    cwd: row.cwd ? String(row.cwd) : null,
    server: row.server_name ? String(row.server_name) : null,
    toolName: row.tool_name ? String(row.tool_name) : null,
    input: String(row.input_text ?? ""),
    output: String(row.output_text ?? ""),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

function mapTokenUsage(row: Record<string, unknown>): TokenUsageRecord | null {
  if (row.total_tokens == null) {
    return null;
  }
  return {
    inputTokens: Number(row.input_tokens ?? 0),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
    totalTokens: Number(row.total_tokens)
  };
}

function mapDetail(raw: unknown): MessageDetail {
  if (!raw || typeof raw !== "object") return {};
  return raw as MessageDetail;
}

function mapMessage(row: Record<string, unknown>): Omit<MessageRecord, "toolResults"> {
  return {
    id: Number(row.id),
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    role:
      row.role === "assistant" || row.role === "system"
        ? row.role
        : "user",
    status:
      row.status === "pending" ||
      row.status === "streaming" ||
      row.status === "error" ||
      row.status === "interrupted"
        ? row.status
        : "completed",
    content: String(row.content_text ?? ""),
    reasoningContent: String(row.reasoning_content ?? ""),
    planContent: String(row.plan_content ?? ""),
    tokenUsage: mapTokenUsage(row),
    modelName: row.model_name != null ? String(row.model_name) : null,
    costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
    feedbackRating:
      row.feedback_rating === "thumbs_up" || row.feedback_rating === "thumbs_down"
        ? row.feedback_rating
        : null,
    detail: mapDetail(row.detail_json),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

export type CreateMessageInput = {
  tenantId: string;
  sessionId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  status: "pending" | "streaming" | "completed" | "error" | "interrupted";
  content: string;
  detail?: MessageDetail;
};

export type UpsertToolResultInput = {
  tenantId: string;
  toolResultId: string;
  messageId: string;
  sessionId: string;
  userId: string;
  kind: "command" | "mcp";
  title: string;
  status: ToolResultRecord["status"];
  command: string | null;
  cwd: string | null;
  server: string | null;
  toolName: string | null;
  input: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
};

function groupToolResults(toolResults: ToolResultRecord[]): Map<string, ToolResultRecord[]> {
  const grouped = new Map<string, ToolResultRecord[]>();

  for (const toolResult of toolResults) {
    const current = grouped.get(toolResult.messageId);
    if (current) {
      current.push(toolResult);
      continue;
    }

    grouped.set(toolResult.messageId, [toolResult]);
  }

  return grouped;
}

/** DB columns are NOT NULL; coerce missing values to empty string. */
function ensureNonNullText(value: string | null | undefined): string {
  return value ?? "";
}

// Persisted-text caps. Tool output in particular comes from an untrusted source
// — a misbehaving or malicious tool can emit GB-scale stdout — and is stored in
// full, so an upper bound on what reaches the DB is the only thing protecting
// storage and later read/serialize cost. Assistant content/reasoning/plan are
// model-produced and effectively bounded by context, but capped here too as
// defense in depth. These are storage limits, not correctness limits: we keep
// the head of the text (where the signal usually is) and append a marker.
export const MAX_TOOL_RESULT_TEXT_LENGTH = 1_000_000;
export const MAX_MESSAGE_CONTENT_LENGTH = 1_000_000;

// Single source of truth for the columns returned by message and tool-result
// mutations — keeps the RETURNING clauses (and the shape mapMessage /
// mapToolResult expect) in sync across the create/update/upsert/append queries.
const MESSAGE_RETURNING_COLUMNS = `id, message_id, session_id, user_id, role, status, content_text,
                    reasoning_content, plan_content,
                    input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
                    model_name, cost_usd, feedback_rating, feedback_notes, feedback_given_at,
                    detail_json,
                    created_at, updated_at`;

const TOOL_RESULT_RETURNING_COLUMNS = `id,
          tool_result_id,
          message_id,
          session_id,
          user_id,
          kind,
          title,
          status,
          command_text,
          cwd,
          server_name,
          tool_name,
          input_text,
          output_text,
          exit_code,
          duration_ms,
          created_at,
          updated_at`;

function truncateForStorage(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const marker = `\n\n[… truncated ${value.length - max} characters for storage]`;
  return value.slice(0, max) + marker;
}

export class MessageStore {
  constructor(private readonly db: Pool) {}

  async getOwned(tenantId: string, messageId: string, userId: string): Promise<MessageRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const messageRows = await client.query(
        `
          SELECT id, message_id, session_id, user_id, role, status, content_text,
                 reasoning_content, plan_content,
                 input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
                 model_name, cost_usd, feedback_rating,
                 detail_json,
                 created_at, updated_at
          FROM messages
          WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3
          LIMIT 1
`,
        [tenantId, messageId, userId]
      );

      return messageRows.rows[0]
        ? {
            ...mapMessage(messageRows.rows[0]),
            toolResults: []
          }
        : null;
    });
  }

  async listBySession(tenantId: string, sessionId: string, userId: string): Promise<MessageRecord[]> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const [messageResult, toolResult] = await Promise.all([
        client.query(
          `
            SELECT id, message_id, session_id, user_id, role, status, content_text,
                   reasoning_content, plan_content,
                   input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
                   model_name, cost_usd, feedback_rating, feedback_notes, feedback_given_at,
                   detail_json,
                   created_at, updated_at
            FROM messages
            WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3
              AND COALESCE(detail_json->>'kind', '') <> 'session_titling'
            ORDER BY created_at ASC, id ASC
          `,
          [tenantId, sessionId, userId]
        ),
        client.query(
          `
            SELECT
              id,
              tool_result_id,
              message_id,
              session_id,
              user_id,
              kind,
              title,
              status,
              command_text,
              cwd,
              server_name,
              tool_name,
              input_text,
              output_text,
              exit_code,
              duration_ms,
              created_at,
              updated_at
            FROM message_tool_results
            WHERE tenant_id = $1 AND session_id = $2 AND user_id = $3
            ORDER BY created_at ASC, id ASC
          `,
          [tenantId, sessionId, userId]
        )
      ]);

      const grouped = groupToolResults(toolResult.rows.map(mapToolResult));

      return messageResult.rows.map((row) => {
        const message = mapMessage(row);
        return {
          ...message,
          toolResults: grouped.get(message.messageId) ?? []
        };
      });
    });
  }

  async create(input: CreateMessageInput): Promise<MessageRecord> {
    const messageId = uuidv7();
    return withTenantScope(this.db, input.tenantId, async (client) => {
      const insertedMessage = await client.query(
        `
          INSERT INTO messages (message_id, tenant_id, session_id, user_id, role, status, content_text, detail_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
          RETURNING ${MESSAGE_RETURNING_COLUMNS}
        `,
        [
          messageId,
          input.tenantId,
          input.sessionId,
          input.userId,
          input.role,
          input.status,
          truncateForStorage(input.content, MAX_MESSAGE_CONTENT_LENGTH),
          JSON.stringify(input.detail ?? {})
        ]
      );

      return {
        ...mapMessage(insertedMessage.rows[0]),
        toolResults: []
      };
    });
  }

  /**
   * Shallow-merges the supplied PII detail under `detail_json.pii`. Other
   * top-level keys in `detail_json` are preserved.
   */
  async setPiiDetail(
    tenantId: string,
    messageId: string,
    pii: MessagePiiDetail
  ): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE messages
          SET detail_json = jsonb_set(
                COALESCE(detail_json, '{}'::jsonb),
                '{pii}',
                COALESCE(detail_json->'pii', '{}'::jsonb) || $3::jsonb,
                true
              ),
              updated_at = NOW()
          WHERE tenant_id = $1 AND message_id = $2
        `,
        [tenantId, messageId, JSON.stringify(pii)]
      );
    });
  }

  async updateContent(
    tenantId: string,
    messageId: string,
    userId: string,
    status: MessageRecord["status"],
    content: string
  ): Promise<MessageRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const updatedMessage = await client.query(
        `
          UPDATE messages
          SET status = $4, content_text = $5, updated_at = NOW()
          WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3
          RETURNING ${MESSAGE_RETURNING_COLUMNS}
        `,
        [tenantId, messageId, userId, status, truncateForStorage(content, MAX_MESSAGE_CONTENT_LENGTH)]
      );

      return updatedMessage.rows[0]
        ? {
            ...mapMessage(updatedMessage.rows[0]),
            toolResults: []
          }
        : null;
    });
  }

  async updateStreamingContent(
    tenantId: string,
    messageId: string,
    userId: string,
    content: {
      reasoningContent?: string;
      planContent?: string;
    }
  ): Promise<void> {
    if (content.reasoningContent === undefined && content.planContent === undefined) {
      return;
    }
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE messages
          SET reasoning_content = COALESCE($4, reasoning_content),
              plan_content      = COALESCE($5, plan_content),
              updated_at        = NOW()
          WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3
        `,
        [
          tenantId,
          messageId,
          userId,
          content.reasoningContent === undefined
            ? null
            : truncateForStorage(content.reasoningContent, MAX_MESSAGE_CONTENT_LENGTH),
          content.planContent === undefined
            ? null
            : truncateForStorage(content.planContent, MAX_MESSAGE_CONTENT_LENGTH)
        ]
      );
    });
  }

  /**
   * Atomically add the given usage to the message's running totals and
   * return the new cumulative usage so the caller can compute a fresh
   * cost_usd from the model's pricing table.
   *
   * Per-turn semantics: one assistant message can be backed by N upstream
   * model calls (Claude with tool use, Codex with multi-step reasoning).
   * A REPLACE-style update would record only the last call's numbers and
   * silently undercount production usage; INCREMENT-then-recalc is the
   * only correct shape here.
   */
  async addTokenUsage(
    tenantId: string,
    messageId: string,
    userId: string,
    delta: TokenUsageRecord,
    modelName: string | null
  ): Promise<TokenUsageRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const result = await client.query<{
        input_tokens: string | number;
        cached_input_tokens: string | number;
        output_tokens: string | number;
        reasoning_output_tokens: string | number;
        total_tokens: string | number;
      }>(
        `
          UPDATE messages
          SET input_tokens            = COALESCE(input_tokens, 0)            + $4,
              cached_input_tokens     = COALESCE(cached_input_tokens, 0)     + $5,
              output_tokens           = COALESCE(output_tokens, 0)           + $6,
              reasoning_output_tokens = COALESCE(reasoning_output_tokens, 0) + $7,
              total_tokens            = COALESCE(total_tokens, 0)            + $8,
              model_name              = COALESCE($9, model_name),
              updated_at              = NOW()
          WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3
          RETURNING input_tokens, cached_input_tokens, output_tokens,
                    reasoning_output_tokens, total_tokens
        `,
        [
          tenantId,
          messageId,
          userId,
          delta.inputTokens,
          delta.cachedInputTokens,
          delta.outputTokens,
          delta.reasoningOutputTokens,
          delta.totalTokens,
          modelName
        ]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        inputTokens: Number(row.input_tokens),
        cachedInputTokens: Number(row.cached_input_tokens),
        outputTokens: Number(row.output_tokens),
        reasoningOutputTokens: Number(row.reasoning_output_tokens),
        totalTokens: Number(row.total_tokens)
      };
    });
  }

  async setCostUsd(
    tenantId: string,
    messageId: string,
    userId: string,
    costUsd: number | null
  ): Promise<void> {
    await withTenantScope(this.db, tenantId, async (client) => {
      await client.query(
        `
          UPDATE messages
          SET cost_usd   = $4,
              updated_at = NOW()
          WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3
        `,
        [tenantId, messageId, userId, costUsd]
      );
    });
  }

  async upsertToolResult(input: UpsertToolResultInput): Promise<ToolResultRecord> {
    return withTenantScope(this.db, input.tenantId, async (client) => {
    const upsertedToolResult = await client.query(
      `
        INSERT INTO message_tool_results (
          tenant_id,
          tool_result_id,
          message_id,
          session_id,
          user_id,
          kind,
          title,
          status,
          command_text,
          cwd,
          server_name,
          tool_name,
          input_text,
          output_text,
          exit_code,
          duration_ms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (tool_result_id)
        DO UPDATE SET
          title = EXCLUDED.title,
          status = EXCLUDED.status,
          command_text = EXCLUDED.command_text,
          cwd = EXCLUDED.cwd,
          server_name = EXCLUDED.server_name,
          tool_name = EXCLUDED.tool_name,
          input_text = EXCLUDED.input_text,
          output_text = EXCLUDED.output_text,
          exit_code = EXCLUDED.exit_code,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = NOW()
        RETURNING
          ${TOOL_RESULT_RETURNING_COLUMNS}
      `,
      [
        input.tenantId,
        input.toolResultId,
        input.messageId,
        input.sessionId,
        input.userId,
        input.kind,
        input.title,
        input.status,
        ensureNonNullText(input.command),
        ensureNonNullText(input.cwd),
        ensureNonNullText(input.server),
        ensureNonNullText(input.toolName),
        truncateForStorage(ensureNonNullText(input.input), MAX_TOOL_RESULT_TEXT_LENGTH),
        truncateForStorage(ensureNonNullText(input.output), MAX_TOOL_RESULT_TEXT_LENGTH),
        input.exitCode,
        input.durationMs
      ]
    );

      return mapToolResult(upsertedToolResult.rows[0]);
    });
  }

  async updateFeedback(
    tenantId: string,
    messageId: string,
    userId: string,
    rating: MessageFeedbackRating,
    notes: string | null
  ): Promise<boolean> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const feedbackUpdate = await client.query(
        `
          UPDATE messages
          SET feedback_rating   = $4,
              feedback_notes    = $5,
              feedback_given_at = NOW(),
              updated_at        = NOW()
          WHERE tenant_id = $1 AND message_id = $2 AND user_id = $3 AND role = 'assistant'
        `,
        [tenantId, messageId, userId, rating, notes]
      );
      return (feedbackUpdate.rowCount ?? 0) > 0;
    });
  }

  async appendToolResultOutput(tenantId: string, toolResultId: string, userId: string, delta: string): Promise<ToolResultRecord | null> {
    return withTenantScope(this.db, tenantId, async (client) => {
      const appendedToolResult = await client.query(
        `
          UPDATE message_tool_results
          SET output_text = output_text || $4, updated_at = NOW()
          WHERE tenant_id = $1 AND tool_result_id = $2 AND user_id = $3
          RETURNING
            ${TOOL_RESULT_RETURNING_COLUMNS}
        `,
        [tenantId, toolResultId, userId, delta]
      );

      return appendedToolResult.rows[0] ? mapToolResult(appendedToolResult.rows[0]) : null;
    });
  }
}
