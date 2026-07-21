/**
 * Deep Agents eval harness (bead AgenticEntrepriseFramework-im5e.5).
 *
 * Runs a small knowledge-worker task set on the Deep Agents runtime against
 * a locally running backend, scoring each run with deterministic programmatic
 * checks and recording latency, token, and cost metrics.
 *
 * Usage (backend must be running):
 *
 *   cd apps/backend && pnpm exec tsx src/scripts/eval-deep-agents.ts \
 *     --tasks csv,chart,mcp --reps 2 --out eval-results.json
 *
 * Requires MIGRATION_DATABASE_URL (reads messages/artifacts rows across RLS)
 * and dev-headers auth (EVAL_USER_ID, default local-dev-user).
 */

import { Client } from "pg";

const API_URL = process.env.EVAL_API_URL ?? "http://localhost:3001";
const USER_ID = process.env.EVAL_USER_ID ?? "local-dev-user";
const TENANT_ID = process.env.EVAL_TENANT_ID ?? "local-dev-tenant";
const TURN_TIMEOUT_MS = Number(process.env.EVAL_TURN_TIMEOUT_MS ?? 600_000);

const PROVIDER_MODELS: Record<string, string> = {
  "deep-agents": "deepagents/claude-sonnet-5"
};

// --- Fixtures ---------------------------------------------------------------

// Column totals: North 147075, South 125315, East 157625, West 183955.
// Grand total 613970. Top region: West.
const SALES_CSV = `region,month,revenue,units
North,2026-01,48210,391
North,2026-02,51875,404
North,2026-03,46990,377
South,2026-01,39480,315
South,2026-02,41220,342
South,2026-03,44615,358
East,2026-01,52340,428
East,2026-02,49875,401
East,2026-03,55410,447
West,2026-01,61250,502
West,2026-02,58730,488
West,2026-03,63975,517
`;

const SECRET_NOTE = `# Project Aurora — internal note

Go-live date: 2026-09-17.
Vault passphrase: AZURE-7741.
Do not share outside the pilot team.
`;

interface TaskCheckContext {
  assistantText: string;
  toolNames: string[];
  sessionId: string;
  turnStartedAt: Date;
  db: Client;
}

interface TaskCheck {
  name: string;
  run: (ctx: TaskCheckContext) => Promise<boolean> | boolean;
}

interface EvalTask {
  id: string;
  prompt: string;
  uploads: Array<{ name: string; mimeType: string; content: string; attach: boolean }>;
  checks: TaskCheck[];
}

const normalize = (text: string) => text.replace(/[,\s\u00A0]/g, "").toLowerCase();

const TASKS: EvalTask[] = [
  {
    id: "csv",
    prompt:
      "I've attached monthly-sales.csv. Answer precisely: (1) What is the total revenue " +
      "across all rows? (2) Which region has the highest total revenue? Give exact numbers.",
    uploads: [{ name: "monthly-sales.csv", mimeType: "text/csv", content: SALES_CSV, attach: true }],
    checks: [
      { name: "total-revenue-613970", run: ({ assistantText }) => normalize(assistantText).includes("613970") },
      { name: "top-region-west", run: ({ assistantText }) => /west/i.test(assistantText) }
    ]
  },
  {
    id: "chart",
    prompt:
      "I've attached monthly-sales.csv. Create a PNG bar chart of total revenue by region " +
      "and save it as an artifact named revenue-by-region.png using the write_artifact tool.",
    uploads: [{ name: "monthly-sales.csv", mimeType: "text/csv", content: SALES_CSV, attach: true }],
    checks: [
      {
        name: "write-artifact-tool-called",
        run: ({ toolNames }) => toolNames.some((name) => name.includes("write_artifact"))
      },
      {
        name: "png-artifact-created",
        run: async ({ db, sessionId, turnStartedAt }) => {
          const result = await db.query(
            `SELECT artifact_name, mime_type, file_size_bytes FROM artifacts
             WHERE session_id = $1 AND status = 'ready' AND created_at >= $2
               AND (mime_type = 'image/png' OR artifact_name ILIKE '%.png')`,
            [sessionId, turnStartedAt]
          );
          return result.rows.some((row) => Number(row.file_size_bytes) > 0);
        }
      }
    ]
  },
  {
    id: "mcp",
    prompt:
      "Earlier I uploaded a file named secret-note.md to this session, but I have NOT attached " +
      "it to this message. Use your artifact tools (list_artifacts, read_text_artifact) to find " +
      "and read it, then tell me the vault passphrase exactly as written.",
    uploads: [{ name: "secret-note.md", mimeType: "text/markdown", content: SECRET_NOTE, attach: false }],
    checks: [
      { name: "passphrase-found", run: ({ assistantText }) => assistantText.includes("AZURE-7741") },
      {
        name: "read-text-artifact-tool-called",
        run: ({ toolNames }) => toolNames.some((name) => name.includes("read_text_artifact"))
      }
    ]
  }
];

// --- HTTP helpers -----------------------------------------------------------

const authHeaders = { "x-user-id": USER_ID, "x-tenant-id": TENANT_ID };

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = { ...authHeaders, ...((init.headers as Record<string, string>) ?? {}) };
  if (init.body !== undefined && typeof init.body === "string" && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function uploadArtifact(sessionId: string, name: string, mimeType: string, content: string): Promise<string> {
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("name", name);
  form.append("file", new Blob([content], { type: mimeType }), name);
  const response = await fetch(`${API_URL}/artifacts`, { method: "POST", headers: authHeaders, body: form });
  if (!response.ok) {
    throw new Error(`POST /artifacts failed with ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { artifact: { artifactId: string } };
  return body.artifact.artifactId;
}

interface SseResult {
  assistantText: string;
  completedStatus: string | null;
  failedMessage: string | null;
  eventTypes: string[];
  toolNames: string[];
  approvalsGranted: number;
  firstEventMs: number | null;
  firstTextDeltaMs: number | null;
  totalMs: number;
}

async function streamTurn(body: object): Promise<SseResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);

  const eventTypes = new Set<string>();
  const toolNames = new Set<string>();
  let approvalsGranted = 0;
  let assistantText = "";
  let completedStatus: string | null = null;
  let failedMessage: string | null = null;
  let firstEventMs: number | null = null;
  let firstTextDeltaMs: number | null = null;

  try {
    const response = await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      throw new Error(`POST /messages failed with ${response.status}: ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!eventLine || !dataLine) continue;

        const event = eventLine.slice(7);
        const payload = JSON.parse(dataLine.slice(6));
        eventTypes.add(event);
        if (firstEventMs === null) firstEventMs = Date.now() - startedAt;

        if (event === "response.output_text.delta" && typeof payload.delta === "string") {
          if (firstTextDeltaMs === null) firstTextDeltaMs = Date.now() - startedAt;
          assistantText += payload.delta;
        }
        if ((event === "response.tool.started" || event === "response.tool.completed") && payload.tool_result) {
          const name = payload.tool_result.toolName ?? payload.tool_result.title;
          if (typeof name === "string" && name.length > 0) toolNames.add(name);
        }
        if (event === "framework:approval_required" && payload.approval?.approvalId) {
          // Stand in for the user: grant every runtime approval promptly.
          // Without this, gated turns park on APPROVAL_REQUEST_TTL_MS (10 min).
          approvalsGranted += 1;
          void api(`/approvals/${payload.approval.approvalId}/decision`, {
            method: "POST",
            body: JSON.stringify({ decision: "approve" })
          }).catch((error: unknown) => {
            console.warn(`  approval decision failed: ${String(error)}`);
          });
        }
        if (event === "response.failed") failedMessage = payload.error?.message ?? "unknown failure";
        if (event === "response.completed") completedStatus = payload.response?.status ?? null;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    assistantText,
    completedStatus,
    failedMessage,
    eventTypes: [...eventTypes].sort(),
    toolNames: [...toolNames].sort(),
    approvalsGranted,
    firstEventMs,
    firstTextDeltaMs,
    totalMs: Date.now() - startedAt
  };
}

// --- Run loop ---------------------------------------------------------------

interface RunRecord {
  provider: string;
  model: string;
  task: string;
  rep: number;
  sessionId: string;
  ok: boolean;
  completedStatus: string | null;
  failedMessage: string | null;
  checks: Record<string, boolean>;
  approvalsGranted: number;
  firstEventMs: number | null;
  firstTextDeltaMs: number | null;
  totalMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  eventTypes: string[];
  toolNames: string[];
  assistantTextPreview: string;
  error: string | null;
}

async function fetchTurnAccounting(db: Client, sessionId: string, turnStartedAt: Date) {
  // Cost is persisted after the stream closes; poll briefly.
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await db.query(
      `SELECT input_tokens, output_tokens, total_tokens, cost_usd FROM messages
       WHERE session_id = $1 AND role = 'assistant' AND created_at >= $2
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId, turnStartedAt]
    );
    const row = result.rows[0];
    if (row && (row.cost_usd !== null || attempt === 9)) {
      return {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd)
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
}

async function runOne(db: Client, provider: string, task: EvalTask, rep: number): Promise<RunRecord> {
  const model = PROVIDER_MODELS[provider];
  const label = `${provider}/${task.id}#${rep}`;
  const record: RunRecord = {
    provider,
    model,
    task: task.id,
    rep,
    sessionId: "",
    ok: false,
    completedStatus: null,
    failedMessage: null,
    checks: {},
    approvalsGranted: 0,
    firstEventMs: null,
    firstTextDeltaMs: null,
    totalMs: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    eventTypes: [],
    toolNames: [],
    assistantTextPreview: "",
    error: null
  };

  try {
    const created = (await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: `eval ${label} ${new Date().toISOString()}` })
    })) as { session: { sessionId: string } };
    record.sessionId = created.session.sessionId;

    const attachedIds: string[] = [];
    for (const upload of task.uploads) {
      const artifactId = await uploadArtifact(record.sessionId, upload.name, upload.mimeType, upload.content);
      if (upload.attach) attachedIds.push(artifactId);
    }

    const turnStartedAt = new Date();
    const stream = await streamTurn({
      sessionId: record.sessionId,
      text: task.prompt,
      model,
      ...(attachedIds.length > 0 ? { artifactIds: attachedIds } : {})
    });

    record.completedStatus = stream.completedStatus;
    record.failedMessage = stream.failedMessage;
    record.firstEventMs = stream.firstEventMs;
    record.firstTextDeltaMs = stream.firstTextDeltaMs;
    record.totalMs = stream.totalMs;
    record.eventTypes = stream.eventTypes;
    record.toolNames = stream.toolNames;
    record.approvalsGranted = stream.approvalsGranted;
    record.assistantTextPreview = stream.assistantText.slice(0, 500);

    const checkContext: TaskCheckContext = {
      assistantText: stream.assistantText,
      toolNames: stream.toolNames,
      sessionId: record.sessionId,
      turnStartedAt,
      db
    };
    for (const check of task.checks) {
      record.checks[check.name] = await check.run(checkContext);
    }

    const accounting = await fetchTurnAccounting(db, record.sessionId, turnStartedAt);
    Object.assign(record, accounting);

    record.ok =
      stream.completedStatus === "completed" &&
      stream.failedMessage === null &&
      Object.values(record.checks).every(Boolean);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }

  return record;
}

function summarize(records: RunRecord[]): void {
  const byArm = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.provider} · ${record.task}`;
    byArm.set(key, [...(byArm.get(key) ?? []), record]);
  }

  const rows = [...byArm.entries()].map(([arm, runs]) => {
    const passed = runs.filter((run) => run.ok).length;
    const median = (values: Array<number | null>) => {
      const nums = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
      return nums.length === 0 ? null : nums[Math.floor(nums.length / 2)];
    };
    const totalCost = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    return {
      arm,
      pass: `${passed}/${runs.length}`,
      firstTextDeltaMs: median(runs.map((run) => run.firstTextDeltaMs)),
      totalMs: median(runs.map((run) => run.totalMs)),
      medTotalTokens: median(runs.map((run) => run.totalTokens)),
      totalCostUsd: Number(totalCost.toFixed(4))
    };
  });
  console.table(rows);
}

function parseListArg(name: string, fallback: string[]): string[] {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) return fallback;
  return process.argv[index + 1].split(",").map((value) => value.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const providers = parseListArg("providers", Object.keys(PROVIDER_MODELS));
  const taskIds = parseListArg("tasks", TASKS.map((task) => task.id));
  const reps = Number(parseListArg("reps", ["2"])[0]);
  const outPath = parseListArg("out", ["eval-results.json"])[0];

  for (const provider of providers) {
    if (!PROVIDER_MODELS[provider]) throw new Error(`Unknown provider: ${provider}`);
  }
  const tasks = TASKS.filter((task) => taskIds.includes(task.id));
  if (tasks.length === 0) throw new Error(`No tasks matched: ${taskIds.join(",")}`);

  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required (cross-RLS reads of messages/artifacts)");
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();

  const records: RunRecord[] = [];
  try {
    for (const provider of providers) {
      for (const task of tasks) {
        for (let rep = 1; rep <= reps; rep++) {
          const label = `${provider}/${task.id}#${rep}`;
          console.log(`\n▶ ${label} (model ${PROVIDER_MODELS[provider]})`);
          const record = await runOne(db, provider, task, rep);
          records.push(record);
          const checks = Object.entries(record.checks)
            .map(([name, passed]) => `${passed ? "✓" : "✗"} ${name}`)
            .join("  ");
          console.log(
            `  ${record.ok ? "PASS" : "FAIL"} status=${record.completedStatus} ` +
              `ttfd=${record.firstTextDeltaMs}ms total=${record.totalMs}ms ` +
              `tokens=${record.totalTokens} cost=$${record.costUsd ?? "?"} approvals=${record.approvalsGranted}\n  ${checks}` +
              (record.error ? `\n  error: ${record.error}` : "") +
              (record.failedMessage ? `\n  failed: ${record.failedMessage}` : "")
          );
        }
      }
    }
  } finally {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outPath, JSON.stringify(records, null, 2));
    console.log(`\nWrote ${records.length} run records to ${outPath}`);
    summarize(records);
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
