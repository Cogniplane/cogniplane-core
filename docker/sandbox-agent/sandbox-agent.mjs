#!/usr/bin/env node
/*
 * Cogniplane in-sandbox Claude harness.
 *
 * Runs inside the E2B `agent-runtime-dev` template. Drives
 * `@anthropic-ai/claude-agent-sdk` for a long-lived session and exchanges
 * newline-delimited JSON frames with the backend over stdio. The protocol
 * is defined in apps/backend/src/services/sandbox-agent-protocol.ts.
 *
 * The Claude SDK is installed globally in the template image; the harness
 * resolves it via NODE_PATH=/usr/lib/node_modules set in the Dockerfile.
 */

import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Inline RFC 9562 UUIDv7 — kept self-contained so the harness has no extra
// runtime deps beyond what the template image provides.
let lastUuidMs = 0n;
let lastUuidTail = 0n;
function uuidv7() {
  let ms = BigInt(Date.now());
  const rand = randomBytes(10);
  let tail =
    ((BigInt(rand[0]) & 0x0fn) << 72n) |
    (BigInt(rand[1]) << 64n) |
    (BigInt(rand[2]) << 56n) |
    (BigInt(rand[3]) << 48n) |
    (BigInt(rand[4]) << 40n) |
    (BigInt(rand[5]) << 32n) |
    (BigInt(rand[6]) << 24n) |
    (BigInt(rand[7]) << 16n) |
    (BigInt(rand[8]) << 8n) |
    BigInt(rand[9]);
  if (ms <= lastUuidMs) {
    ms = lastUuidMs;
    tail = lastUuidTail + 1n;
    if (tail >> 76n) {
      ms += 1n;
      tail = 0n;
    }
  }
  lastUuidMs = ms;
  lastUuidTail = tail;
  const buf = Buffer.alloc(16);
  buf.writeUIntBE(Number(ms), 0, 6);
  buf[6] = 0x70 | Number((tail >> 72n) & 0x0fn);
  buf[7] = Number((tail >> 64n) & 0xffn);
  buf[8] = 0x80 | Number((tail >> 56n) & 0x3fn);
  buf[9] = Number((tail >> 48n) & 0xffn);
  buf[10] = Number((tail >> 40n) & 0xffn);
  buf[11] = Number((tail >> 32n) & 0xffn);
  buf[12] = Number((tail >> 24n) & 0xffn);
  buf[13] = Number((tail >> 16n) & 0xffn);
  buf[14] = Number((tail >> 8n) & 0xffn);
  buf[15] = Number(tail & 0xffn);
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emit(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function log(level, message, fields) {
  emit({ type: "log", level, message, ...(fields ? { fields } : {}) });
}

// Any unhandled rejection surfaces as a `log` frame; the backend treats harness
// crashes as a sandbox failure and recycles the sandbox.
process.on("unhandledRejection", (err) => {
  log("error", "unhandledRejection in sandbox-agent", {
    error: err instanceof Error ? err.message : String(err)
  });
});
process.on("uncaughtException", (err) => {
  log("error", "uncaughtException in sandbox-agent", { error: err.message });
});

// ---------------------------------------------------------------------------
// SDK loading (lazy; allows us to emit `ready` with a helpful error if missing)
// ---------------------------------------------------------------------------

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import("@anthropic-ai/claude-agent-sdk").catch((err) => {
      log("error", "Failed to load @anthropic-ai/claude-agent-sdk", {
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    });
  }
  return sdkPromise;
}

function readSdkVersion() {
  try {
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json");
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Approval bridge — replaces the local adapter's ClaudeApprovalHandler
// ---------------------------------------------------------------------------

const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
const READ_ONLY_NATIVE_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "View"]);

function extractManagedToolName(toolName) {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  return rest.slice(sep + 2);
}

function classifyToolKind(toolName) {
  return FILE_CHANGE_TOOLS.has(toolName) ? "file_change" : "command_execution";
}

function enrichInput(toolInput, toolContextId, toolName) {
  if (!toolContextId) return toolInput;
  if (!toolName.startsWith("mcp__")) return toolInput;
  if (
    typeof toolInput?.toolContextId === "string" &&
    toolInput.toolContextId.length > 0
  ) {
    return toolInput;
  }
  return { ...toolInput, toolContextId };
}

/**
 * Per-turn approval bridge. Each turn gets a fresh instance bound to the
 * current toolContextId + policy flags. Pending approvals live here until
 * the backend answers with an `approval_response` frame.
 */
function createApprovalBridge(options) {
  const pending = new Map();

  function resolve(approvalId, decision) {
    const entry = pending.get(approvalId);
    if (!entry) return false;
    pending.delete(approvalId);
    if (decision === "approve") {
      entry.resolve({
        behavior: "allow",
        updatedInput: enrichInput(entry.toolInput, options.toolContextId, entry.toolName)
      });
    } else {
      entry.resolve({ behavior: "deny", message: "User denied permission." });
    }
    return true;
  }

  function cancelAll(reason) {
    for (const [, entry] of pending) {
      entry.resolve({ behavior: "deny", message: reason });
    }
    pending.clear();
  }

  async function canUseTool(toolName, toolInput, opts) {
    // autoApproveReadOnly for native read-only tools
    if (options.autoApproveReadOnly && READ_ONLY_NATIVE_TOOLS.has(toolName)) {
      return {
        behavior: "allow",
        updatedInput: enrichInput(toolInput, options.toolContextId, toolName)
      };
    }

    // Bypass mode — still inject toolContextId
    if (options.bypass) {
      return {
        behavior: "allow",
        updatedInput: enrichInput(toolInput, options.toolContextId, toolName)
      };
    }

    // autoApproveReadOnly for known-read-only managed MCP tools
    if (toolName.startsWith("mcp__") && options.autoApproveReadOnly) {
      const catalogName = extractManagedToolName(toolName);
      if (catalogName && options.readOnlyManagedToolNames.has(catalogName)) {
        return {
          behavior: "allow",
          updatedInput: enrichInput(toolInput, options.toolContextId, toolName)
        };
      }
    }

    // Fall through — prompt the user via approval_request
    const approvalId = uuidv7();
    const kind = classifyToolKind(toolName);

    return new Promise((resolveFn) => {
      pending.set(approvalId, { resolve: resolveFn, toolName, toolInput });

      if (opts?.signal) {
        if (opts.signal.aborted) {
          pending.delete(approvalId);
          resolveFn({ behavior: "deny", message: "Aborted." });
          return;
        }
        opts.signal.addEventListener(
          "abort",
          () => {
            if (pending.delete(approvalId)) {
              resolveFn({ behavior: "deny", message: "Aborted." });
            }
          },
          { once: true }
        );
      }

      emit({
        type: "approval_request",
        approvalId,
        toolName,
        toolInput,
        kind
      });
    });
  }

  return { canUseTool, resolve, cancelAll, get pendingCount() { return pending.size; } };
}

// ---------------------------------------------------------------------------
// Pre-warm state
// ---------------------------------------------------------------------------

// Promise<{ query: WarmQuery; model: string } | null> — set by handleWarmup,
// consumed (awaited + cleared) at the start of the first turn.
let warmStatePromise = null;

async function handleWarmup(frame) {
  const sdk = await loadSdk();
  const mcpServersConfig = {};
  for (const entry of frame.mcpServers ?? []) {
    mcpServersConfig[entry.id] = {
      type: "http",
      url: entry.url,
      headers: { Authorization: entry.authorization }
    };
  }
  const systemPrompt = frame.developerInstructions
    ? { type: "preset", preset: "claude_code", append: frame.developerInstructions }
    : { type: "preset", preset: "claude_code" };

  warmStatePromise = sdk
    .startup({
      options: {
        model: frame.model,
        maxTurns: 100,
        systemPrompt,
        tools: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        ...(Object.keys(mcpServersConfig).length > 0 ? { mcpServers: mcpServersConfig } : {}),
        permissionMode: "default",
        settingSources: ["project"],
        cwd: process.cwd(),
        canUseTool: (toolName, toolInput, opts) => {
          if (warmCanUseToolFn) return warmCanUseToolFn(toolName, toolInput, opts);
          return Promise.resolve({ behavior: "deny", message: "No active turn" });
        }
      }
    })
    .then((wq) => ({ query: wq, model: frame.model }))
    .catch((err) => {
      log("warn", "Claude SDK startup() pre-warm failed; first turn will cold-start", {
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    });
}

// Mutable per-turn delegate for the pre-warm canUseTool wrapper above.
let warmCanUseToolFn = null;

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

let currentTurn = null;

function buildPromptStream(frame) {
  return (async function* () {
    const blocks = Array.isArray(frame.contentBlocks) && frame.contentBlocks.length > 0
      ? frame.contentBlocks
      : [{ type: "text", text: frame.prompt }];

    yield {
      type: "user",
      session_id: frame.resumeSessionId ?? frame.turnId,
      message: { role: "user", content: blocks },
      parent_tool_use_id: null
    };
  })();
}

async function runTurn(frame) {
  if (currentTurn) {
    emit({
      type: "turn_failed",
      turnId: frame.turnId,
      error: "A turn is already in progress in this sandbox."
    });
    return;
  }

  const approvalBridge = createApprovalBridge({
    toolContextId: frame.toolContextId,
    bypass: frame.bypass,
    autoApproveReadOnly: frame.autoApproveReadOnly,
    readOnlyManagedToolNames: new Set(frame.readOnlyManagedToolNames ?? [])
  });

  // pendingInterrupt absorbs Stop clicks that arrive before the SDK iterator
  // has been constructed (warm-resume window, slow imports). Once the iterator
  // is wired up below we replay the deferred call so the turn actually stops.
  currentTurn = { turnId: frame.turnId, approvalBridge, pendingInterrupt: false };
  let claudeSessionId = frame.resumeSessionId;

  // Wire the per-turn handler into the pre-warm delegating wrapper.
  warmCanUseToolFn = (toolName, toolInput, opts) =>
    approvalBridge.canUseTool(toolName, toolInput, opts);

  try {
    const sdk = await loadSdk();

    const mcpServersConfig = {};
    for (const entry of frame.mcpServers ?? []) {
      mcpServersConfig[entry.id] = {
        type: "http",
        url: entry.url,
        headers: { Authorization: entry.authorization }
      };
    }

    const systemPrompt = frame.developerInstructions
      ? { type: "preset", preset: "claude_code", append: frame.developerInstructions }
      : { type: "preset", preset: "claude_code" };

    const baseOptions = {
      model: frame.model,
      maxTurns: 100,
      ...(frame.effort ? { thinking: { type: "adaptive" }, effort: frame.effort } : {}),
      systemPrompt,
      tools: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      ...(Object.keys(mcpServersConfig).length > 0 ? { mcpServers: mcpServersConfig } : {}),
      permissionMode: "default",
      settingSources: ["project"],
      cwd: process.cwd(),
      canUseTool: (toolName, toolInput, toolOpts) =>
        approvalBridge.canUseTool(toolName, toolInput, toolOpts)
    };

    const options = frame.resumeSessionId
      ? { ...baseOptions, resume: frame.resumeSessionId }
      : baseOptions;

    // Consume the pre-warmed subprocess on the first turn when it matches.
    const warmResult = warmStatePromise ? await warmStatePromise : null;
    warmStatePromise = null;

    const useWarm =
      warmResult !== null &&
      !frame.resumeSessionId && // first turn only
      frame.model === warmResult.model &&
      !frame.effort; // effort changes subprocess config; fall back if specified

    if (!useWarm && warmResult) {
      warmResult.query.close();
    }

    const iterator = useWarm
      ? warmResult.query.query(buildPromptStream(frame))
      : sdk.query({ prompt: buildPromptStream(frame), options });

    // Stash the iterator on currentTurn so an inbound `interrupt` frame can
    // call iterator.interrupt(). The SDK then ends the loop with a final
    // `result` message of subtype "interrupt" which flows through normally.
    currentTurn.iterator = iterator;

    // Replay any Stop click that landed before the iterator was constructed.
    if (currentTurn.pendingInterrupt) {
      currentTurn.pendingInterrupt = false;
      Promise.resolve(iterator.interrupt()).catch((err) => {
        log("warn", "deferred iterator.interrupt() rejected", {
          turnId: frame.turnId,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    for await (const message of iterator) {
      // Capture session id from the first system/init
      const maybeSessionId = message?.session_id;
      if (typeof maybeSessionId === "string" && !claudeSessionId) {
        claudeSessionId = maybeSessionId;
      }
      emit({ type: "sdk_message", turnId: frame.turnId, payload: message });
    }

    emit({ type: "turn_complete", turnId: frame.turnId, claudeSessionId: claudeSessionId ?? null });
  } catch (err) {
    approvalBridge.cancelAll("Turn failed.");
    emit({
      type: "turn_failed",
      turnId: frame.turnId,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    currentTurn = null;
  }
}

// ---------------------------------------------------------------------------
// Stdin dispatch
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch (err) {
    log("warn", "Ignoring non-JSON stdin line", {
      preview: trimmed.slice(0, 200),
      error: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  switch (frame?.type) {
    case "warmup":
      void handleWarmup(frame);
      break;
    case "turn":
      void runTurn(frame);
      break;
    case "approval_response":
      if (currentTurn) {
        const ok = currentTurn.approvalBridge.resolve(frame.approvalId, frame.decision);
        if (!ok) {
          log("warn", "approval_response for unknown approvalId", { approvalId: frame.approvalId });
        }
      } else {
        log("warn", "approval_response received without an active turn", {
          approvalId: frame.approvalId
        });
      }
      break;
    case "interrupt":
      if (currentTurn && currentTurn.turnId === frame.turnId) {
        // Cancel any approvals the user is currently being prompted for —
        // their canUseTool callbacks would otherwise hang forever once the
        // iterator stops, blocking the SDK's interrupt-flush path.
        currentTurn.approvalBridge.cancelAll("Turn interrupted.");
        if (currentTurn.iterator) {
          Promise.resolve(currentTurn.iterator.interrupt()).catch((err) => {
            log("warn", "iterator.interrupt() rejected", {
              turnId: frame.turnId,
              error: err instanceof Error ? err.message : String(err)
            });
          });
        } else {
          // Fast Stop during warm-resume / SDK import: defer the interrupt
          // until the iterator exists. Without this the click would be
          // dropped permanently and the turn would keep running even though
          // the backend reported `interrupted` to the user.
          currentTurn.pendingInterrupt = true;
        }
      } else {
        log("warn", "interrupt frame ignored (no matching active turn)", {
          turnId: frame.turnId,
          activeTurnId: currentTurn ? currentTurn.turnId : null
        });
      }
      break;
    case "shutdown":
      log("info", "Shutdown frame received; exiting sandbox-agent");
      rl.close();
      process.exit(0);
      break;
    default:
      log("warn", "Unknown inbound frame type", { type: frame?.type });
  }
});

rl.on("close", () => {
  // stdin closed — exit cleanly so E2B's CommandHandle.wait resolves.
  if (currentTurn) {
    currentTurn.approvalBridge.cancelAll("stdin closed");
  }
  process.exit(0);
});

// Announce readiness before handling any turns
emit({
  type: "ready",
  sdkVersion: readSdkVersion(),
  nodeVersion: process.version
});
