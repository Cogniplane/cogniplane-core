import { parseJudgeOutput, SkillJudgeParseError } from "./skill-judge-parser.js";
import { JUDGE_SYSTEM_PROMPT, renderJudgeUserPrompt } from "./skill-judge-prompt.js";
import type {
  PollResult,
  SkillJudgeInput,
  SkillJudgeProvider,
  SubmissionResult,
  SyncResult
} from "./skill-judge-types.js";

/**
 * Batch provider for the Anthropic Message Batches API.
 *
 *   submit(inputs)          → POST /v1/messages/batches with one request
 *                             per session, custom_id = sessionId.
 *   poll(batchId, ids)      → GET /v1/messages/batches/{id}
 *                             when processing_status === "succeeded",
 *                             stream results via /results, parse each line
 *                             back into a SyncResult keyed by sessionId.
 *
 * Bundling rationale: Anthropic charges 50% of sync rates for batch, so a
 * "one session per batch" implementation defeats the purpose. The provider
 * packs every input into a single batch and the worker stamps every claimed
 * row with the same batch_id. The store's `listInflightBatches` groups rows
 * back together so the poll path runs once per real underlying batch.
 *
 * Failure model:
 *   - Whole batch error (network, 4xx) → submit() throws, worker fails the
 *     entire group. Sessions get a row in `failed` state.
 *   - Per-request error inside a successful batch (e.g. one request hit a
 *     rate limit) → poll() returns that session as
 *     `{ status: "failed", error }`. Other sessions in the same batch
 *     succeed normally.
 *   - Whole batch failed/expired → poll() returns `{ status: "failed" }`,
 *     worker fails every row in the group.
 *
 * Parser failures (model returned non-JSON) are recorded as per-session
 * failures, not batch failures: one rotten apple shouldn't fail a batch of 50.
 */

const ANTHROPIC_BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type AnthropicBatchJudgeProviderInput = {
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Per-HTTP-request timeout. Polling does not block on the batch finishing. */
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
};

export class AnthropicBatchJudgeError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = "AnthropicBatchJudgeError";
  }
}

type CreateBatchResponse = {
  id?: string;
  processing_status?: string;
};

type RetrieveBatchResponse = {
  id?: string;
  processing_status?: "in_progress" | "canceling" | "ended";
  // Older docs use `processing_status: "succeeded" | "failed" | "expired"`.
  // The current API returns `ended` plus a per-batch result location and
  // counts. Treat any of these as terminal — the results endpoint returns
  // 404 if the batch isn't really done.
  ended_at?: string | null;
  expires_at?: string | null;
  results_url?: string | null;
};

type BatchResultLine = {
  custom_id?: string;
  result?: {
    type?: "succeeded" | "errored" | "canceled" | "expired";
    message?: { content?: Array<{ type?: string; text?: string }>; id?: string };
    error?: { type?: string; message?: string };
  };
};

export class AnthropicBatchJudgeProvider implements SkillJudgeProvider {
  readonly providerId = "anthropic";
  readonly mode = "batch" as const;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(input: AnthropicBatchJudgeProviderInput) {
    if (!input.apiKey) throw new Error("AnthropicBatchJudgeProvider requires an apiKey.");
    if (!input.model) throw new Error("AnthropicBatchJudgeProvider requires a model.");
    this.apiKey = input.apiKey;
    this.model = input.model;
    this.maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetcher = input.fetcher ?? fetch;
  }

  async submit(inputs: SkillJudgeInput[]): Promise<SubmissionResult> {
    if (inputs.length === 0) {
      throw new Error("submit() called with no inputs.");
    }
    const requests = inputs.map((input) => ({
      custom_id: input.sessionId,
      params: {
        model: this.model,
        max_tokens: this.maxTokens,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: renderJudgeUserPrompt(input) }]
      }
    }));

    const response = await this.fetchWithTimeout(ANTHROPIC_BATCHES_URL, {
      method: "POST",
      headers: this.headers({ json: true }),
      body: JSON.stringify({ requests })
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new AnthropicBatchJudgeError(
        `Anthropic Batches API returned ${response.status}.`,
        response.status,
        text
      );
    }

    const body = (await response.json()) as CreateBatchResponse;
    if (!body.id) {
      throw new AnthropicBatchJudgeError("Anthropic Batches API response missing id.");
    }

    return {
      mode: "batch",
      batchId: body.id,
      sessionIds: inputs.map((input) => input.sessionId)
    };
  }

  async poll(batchId: string, sessionIds: string[]): Promise<PollResult> {
    const retrieveUrl = `${ANTHROPIC_BATCHES_URL}/${encodeURIComponent(batchId)}`;
    const retrieveResponse = await this.fetchWithTimeout(retrieveUrl, {
      method: "GET",
      headers: this.headers({ json: false })
    });

    if (!retrieveResponse.ok) {
      const text = await safeReadText(retrieveResponse);
      return {
        status: "failed",
        error: `retrieve ${batchId} returned ${retrieveResponse.status}: ${text ?? ""}`.slice(0, 500)
      };
    }

    const status = (await retrieveResponse.json()) as RetrieveBatchResponse;

    // Anthropic's docs use both terminologies depending on which page you read.
    // "in_progress" / "canceling" → still working. Anything else is terminal.
    if (status.processing_status === "in_progress" || status.processing_status === "canceling") {
      return { status: "in_progress" };
    }

    // Terminal: stream results. The results URL may be absolute or relative.
    const resultsUrl = status.results_url
      ? new URL(status.results_url, "https://api.anthropic.com").toString()
      : `${retrieveUrl}/results`;

    const resultsResponse = await this.fetchWithTimeout(resultsUrl, {
      method: "GET",
      headers: this.headers({ json: false, accept: "application/x-jsonl" })
    });

    if (!resultsResponse.ok) {
      // Batch ended but results endpoint failed → treat as failed batch.
      const text = await safeReadText(resultsResponse);
      return {
        status: "failed",
        error: `results ${batchId} returned ${resultsResponse.status}: ${text ?? ""}`.slice(0, 500)
      };
    }

    const text = await resultsResponse.text();
    const parsed = parseJsonLines(text);

    const results = new Map<string, SyncResult>();
    for (const line of parsed) {
      const sessionId = line.custom_id;
      if (!sessionId) continue;
      results.set(sessionId, lineToSyncResult(line));
    }

    // Sessions the batch was supposed to cover but didn't return → mark failed
    // with a structural error. Keeps the worker's invariants simple.
    for (const sessionId of sessionIds) {
      if (!results.has(sessionId)) {
        results.set(sessionId, {
          status: "failed",
          error: `batch ${batchId} ended without a result for session ${sessionId}`
        });
      }
    }

    return { status: "completed", results };
  }

  private headers(opts: { json: boolean; accept?: string }): Record<string, string> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    };
    if (opts.json) headers["content-type"] = "application/json";
    if (opts.accept) headers.accept = opts.accept;
    return headers;
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

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function parseJsonLines(text: string): BatchResultLine[] {
  const lines: BatchResultLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as BatchResultLine);
    } catch {
      // A malformed line shouldn't kill the rest of the batch.
    }
  }
  return lines;
}

function lineToSyncResult(line: BatchResultLine): SyncResult {
  const result = line.result;
  if (!result) {
    return { status: "failed", error: "batch result line had no `result` field" };
  }
  if (result.type === "errored") {
    return {
      status: "failed",
      error: result.error?.message ?? `errored: ${result.error?.type ?? "unknown"}`
    };
  }
  if (result.type === "expired" || result.type === "canceled") {
    return { status: "failed", error: result.type };
  }

  const textBlock = result.message?.content?.find((b) => b.type === "text");
  const raw = textBlock?.text ?? "";
  if (!raw) {
    return { status: "failed", error: "batch result line had no text content" };
  }
  try {
    const output = parseJudgeOutput(raw);
    return { status: "succeeded", output, rawRequestId: result.message?.id ?? null };
  } catch (err) {
    if (err instanceof SkillJudgeParseError) {
      return { status: "failed", error: `parse: ${err.message}` };
    }
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
