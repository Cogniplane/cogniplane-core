import { parseJudgeOutput, SkillJudgeParseError } from "./skill-judge-parser.js";
import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from "./skill-judge-prompt.js";
import { buildOpenAiChatRequest } from "./openai-sync-judge-provider.js";
import type {
  PollResult,
  SkillJudgeInput,
  SkillJudgeProvider,
  SubmissionResult,
  SyncResult
} from "./skill-judge-types.js";

/**
 * Batch provider for OpenAI's three-endpoint batch flow:
 *
 *   submit:  POST /v1/files    (purpose=batch, JSONL upload)
 *            → POST /v1/batches (input_file_id + endpoint)
 *            → returns { batchId, sessionIds }
 *
 *   poll:    GET  /v1/batches/{id}
 *            when status === "completed":
 *              GET /v1/files/{output_file_id}/content
 *
 * One JSONL line per session; `custom_id` is the sessionId so results route
 * back. Parse failures inside otherwise-completed batches become per-session
 * `failed` SyncResults — same posture as the Anthropic batch provider, so
 * the worker stays uniform across providers.
 *
 * The completion_window is 24h (OpenAI's only supported value at the time
 * of writing). The poller is independent of that window — it reads status
 * each tick and acts when the batch reports completed/failed/expired.
 */

const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
const OPENAI_BATCHES_URL = "https://api.openai.com/v1/batches";
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type OpenAIBatchJudgeProviderInput = {
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Per-HTTP-request timeout. Polling does not block on the batch finishing. */
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
};

export class OpenAIBatchJudgeError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "OpenAIBatchJudgeError";
  }
}

type FileUploadResponse = { id?: string };

type BatchResponse = {
  id?: string;
  status?:
    | "validating"
    | "in_progress"
    | "finalizing"
    | "completed"
    | "failed"
    | "expired"
    | "cancelling"
    | "cancelled";
  output_file_id?: string | null;
  error_file_id?: string | null;
  errors?: { object: string; data?: Array<{ code?: string; message?: string }> };
};

type BatchOutputLine = {
  custom_id?: string;
  response?: {
    status_code?: number;
    body?: {
      id?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
  };
  error?: { code?: string; message?: string };
};

export class OpenAIBatchJudgeProvider implements SkillJudgeProvider {
  readonly providerId = "openai";
  readonly mode = "batch" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(input: OpenAIBatchJudgeProviderInput) {
    if (!input.apiKey) throw new Error("OpenAIBatchJudgeProvider requires an apiKey.");
    if (!input.model) throw new Error("OpenAIBatchJudgeProvider requires a model.");
    this.apiKey = input.apiKey;
    this.model = input.model;
    this.maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetcher = input.fetcher ?? fetch;
  }

  async submit(inputs: SkillJudgeInput[]): Promise<SubmissionResult> {
    if (inputs.length === 0) throw new Error("submit() called with no inputs.");

    // 1. Build JSONL: one chat completion request per session, custom_id = sessionId.
    const lines = inputs.map((input) => {
      const body = buildOpenAiChatRequest({
        model: this.model,
        maxTokens: this.maxTokens,
        system: JUDGE_SYSTEM_PROMPT,
        userPrompt: renderJudgeUserPrompt(input)
      });
      return JSON.stringify({
        custom_id: input.sessionId,
        method: "POST",
        url: "/v1/chat/completions",
        body
      });
    });
    const jsonl = `${lines.join("\n")}\n`;

    // 2. Upload as a multipart form. `purpose=batch` is required.
    const form = new FormData();
    form.append(
      "file",
      new Blob([jsonl], { type: "application/jsonl" }),
      `skill-judge-${Date.now()}.jsonl`
    );
    form.append("purpose", "batch");

    const uploadResponse = await this.fetchWithTimeout(OPENAI_FILES_URL, {
      method: "POST",
      headers: this.headers(),
      body: form
    });
    if (!uploadResponse.ok) {
      const text = await safeReadText(uploadResponse);
      throw new OpenAIBatchJudgeError(
        `OpenAI Files upload returned ${uploadResponse.status}.`,
        uploadResponse.status,
        text
      );
    }
    const uploadBody = (await uploadResponse.json()) as FileUploadResponse;
    if (!uploadBody.id) {
      throw new OpenAIBatchJudgeError("OpenAI Files upload returned no file id.");
    }

    // 3. Create the batch pointing at the uploaded file.
    const createResponse = await this.fetchWithTimeout(OPENAI_BATCHES_URL, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({
        input_file_id: uploadBody.id,
        endpoint: "/v1/chat/completions",
        completion_window: "24h"
      })
    });
    if (!createResponse.ok) {
      const text = await safeReadText(createResponse);
      throw new OpenAIBatchJudgeError(
        `OpenAI Batches create returned ${createResponse.status}.`,
        createResponse.status,
        text
      );
    }
    const createBody = (await createResponse.json()) as BatchResponse;
    if (!createBody.id) {
      throw new OpenAIBatchJudgeError("OpenAI Batches create returned no batch id.");
    }

    return {
      mode: "batch",
      batchId: createBody.id,
      sessionIds: inputs.map((input) => input.sessionId)
    };
  }

  async poll(batchId: string, sessionIds: string[]): Promise<PollResult> {
    const retrieveUrl = `${OPENAI_BATCHES_URL}/${encodeURIComponent(batchId)}`;
    const retrieveResponse = await this.fetchWithTimeout(retrieveUrl, {
      method: "GET",
      headers: this.headers()
    });

    if (!retrieveResponse.ok) {
      const text = await safeReadText(retrieveResponse);
      return {
        status: "failed",
        error: `retrieve ${batchId} returned ${retrieveResponse.status}: ${text ?? ""}`.slice(0, 500)
      };
    }

    const status = (await retrieveResponse.json()) as BatchResponse;

    switch (status.status) {
      case "validating":
      case "in_progress":
      case "finalizing":
      case "cancelling":
        return { status: "in_progress" };
      case "failed":
      case "expired":
      case "cancelled":
        return {
          status: "failed",
          error: `batch ${batchId} ${status.status}${describeBatchErrors(status)}`.slice(0, 500)
        };
      case "completed":
        break;
      default:
        // Unknown status — treat as still pending so the next tick re-checks.
        return { status: "in_progress" };
    }

    if (!status.output_file_id) {
      return {
        status: "failed",
        error: `batch ${batchId} completed without an output_file_id`
      };
    }

    const contentUrl = `${OPENAI_FILES_URL}/${encodeURIComponent(status.output_file_id)}/content`;
    const contentResponse = await this.fetchWithTimeout(contentUrl, {
      method: "GET",
      headers: this.headers()
    });
    if (!contentResponse.ok) {
      const text = await safeReadText(contentResponse);
      return {
        status: "failed",
        error: `output file fetch returned ${contentResponse.status}: ${text ?? ""}`.slice(0, 500)
      };
    }

    const text = await contentResponse.text();
    const parsed = parseJsonLines(text);
    const results = new Map<string, SyncResult>();
    for (const line of parsed) {
      const sessionId = line.custom_id;
      if (!sessionId) continue;
      results.set(sessionId, lineToSyncResult(line));
    }
    for (const sessionId of sessionIds) {
      if (!results.has(sessionId)) {
        results.set(sessionId, {
          status: "failed",
          error: `batch ${batchId} completed without a result for session ${sessionId}`
        });
      }
    }
    return { status: "completed", results };
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetcher(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeBatchErrors(status: BatchResponse): string {
  const items = status.errors?.data ?? [];
  if (items.length === 0) return "";
  const first = items[0];
  return `: ${first?.code ?? "error"} ${first?.message ?? ""}`;
}

function parseJsonLines(text: string): BatchOutputLine[] {
  const lines: BatchOutputLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as BatchOutputLine);
    } catch {
      // Malformed line; skip.
    }
  }
  return lines;
}

function lineToSyncResult(line: BatchOutputLine): SyncResult {
  if (line.error) {
    return {
      status: "failed",
      error: line.error.message ?? line.error.code ?? "unknown error"
    };
  }
  const response = line.response;
  if (!response) {
    return { status: "failed", error: "batch result line had no `response` field" };
  }
  if (response.status_code !== undefined && response.status_code >= 400) {
    return { status: "failed", error: `chat completion returned ${response.status_code}` };
  }
  const raw = response.body?.choices?.[0]?.message?.content ?? "";
  if (!raw) return { status: "failed", error: "batch result line had no message content" };

  try {
    const output = parseJudgeOutput(raw);
    return { status: "succeeded", output, rawRequestId: response.body?.id ?? null };
  } catch (err) {
    if (err instanceof SkillJudgeParseError) {
      return { status: "failed", error: `parse: ${err.message}` };
    }
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
