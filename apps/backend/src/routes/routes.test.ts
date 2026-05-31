import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, beforeAll, afterAll, expect, onTestFinished } from "vitest";
import { uuidv7 } from "../lib/uuid.js";

import multipart from "@fastify/multipart";
import Fastify from "fastify";

import { phase4RuntimePolicy } from "../test-helpers/phase4-runtime-policy.js";
import { createProxyMcpUpstream } from "../test-helpers/mcp-route-test-support.js";
import {
  createTestApp,
  createTestToolContext,
  parseSseEvents
} from "../test-helpers/routes-test-support.js";
import { registerArtifactRoutes } from "../routes/artifacts.js";
import { LocalArtifactStorage } from "../services/artifacts/artifact-storage.js";
import { generateRuntimeToken } from "../services/auth/runtime-token.js";
import { InMemoryAuditEventStore } from "../test-helpers/in-memory-audit-events.js";


describe("session lifecycle: create, stream, replay", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let runtimeManager: Awaited<ReturnType<typeof createTestApp>>["runtimeManager"];
  // Phases share state via this closure: each step depends on the previous.
  // Subtests give each phase a specific failure label without duplicating setup.
  let sessionId = "";

  beforeAll(async () => {
    const built = await createTestApp();
    app = built.app;
    runtimeManager = built.runtimeManager;
  });

  afterAll(async () => {
    await app.close();
  });

  test("creates a session via POST /sessions", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: {
        "x-user-id": "platform-user"
      },
      payload: {
        name: "Regression session"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const createPayload = createResponse.json();
    sessionId = createPayload.session.sessionId as string;
  });

  test("streams assistant response over SSE", async () => {
    runtimeManager.queueEvents(sessionId, [
      { type: "response.created", responseId: "resp-1" },
      {
        type: "response.tool.started",
        responseId: "resp-1",
        toolCall: {
          itemId: "cmd-1",
          kind: "command",
          title: "Shell command",
          status: "in_progress",
          command: "pwd",
          cwd: "/tmp/cogniplane-tests",
          server: null,
          toolName: null,
          input: "pwd",
          output: "",
          exitCode: null,
          durationMs: null
        }
      },
      {
        type: "response.tool.output.delta",
        responseId: "resp-1",
        itemId: "cmd-1",
        delta: "/tmp/cogniplane-tests\n"
      },
      {
        type: "response.tool.completed",
        responseId: "resp-1",
        toolCall: {
          itemId: "cmd-1",
          kind: "command",
          title: "Shell command",
          status: "completed",
          command: "pwd",
          cwd: "/tmp/cogniplane-tests",
          server: null,
          toolName: null,
          input: "pwd",
          output: "/tmp/cogniplane-tests\n",
          exitCode: 0,
          durationMs: 42
        }
      },
      { type: "response.output_text.delta", responseId: "resp-1", delta: "Hello" },
      { type: "response.output_text.delta", responseId: "resp-1", delta: " world" },
      { type: "response.output_item.done", responseId: "resp-1" },
      { type: "response.completed", responseId: "resp-1" }
    ]);

    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    const messageResponse = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-user-id": "platform-user"
      },
      body: JSON.stringify({
        sessionId,
        text: "Say hello"
      })
    });

    expect(messageResponse.status).toBe(200);
    expect(messageResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const streamedBody = await messageResponse.text();
    const streamedEvents = parseSseEvents(streamedBody);

    expect(streamedEvents.map((event) => event.event)).toEqual([
              "response.created",
              "response.tool.started",
              "response.tool.output.delta",
              "response.tool.completed",
              "response.output_text.delta",
              "response.output_text.delta",
              "response.output_item.done",
              "response.completed"
            ]);
    expect(streamedEvents[1].data.item_id).toBe("cmd-1");
    expect(streamedEvents[2].data.delta).toBe("/tmp/cogniplane-tests\n");
    expect(streamedEvents[4].data.delta).toBe("Hello");
    expect(streamedEvents[5].data.delta).toBe(" world");
  });

  test("replays persisted history via GET /sessions/:id/messages", async () => {
    const replayResponse = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/messages`,
      headers: {
        "x-user-id": "platform-user"
      }
    });

    expect(replayResponse.statusCode).toBe(200);
    const replayPayload = replayResponse.json();
    expect(replayPayload.messages.length).toBe(2);
    expect(replayPayload.messages[0].role).toBe("user");
    expect(replayPayload.messages[0].content).toBe("Say hello");
    expect(replayPayload.messages[1].role).toBe("assistant");
    expect(replayPayload.messages[1].status).toBe("completed");
    expect(replayPayload.messages[1].content).toBe("Hello world");
    expect(replayPayload.messages[1].toolResults.length).toBe(1);
    expect(replayPayload.messages[1].toolResults[0].command).toBe("pwd");
    expect(replayPayload.messages[1].toolResults[0].output).toBe("/tmp/cogniplane-tests\n");
  });
});

test("rejects concurrent turns on the same session", async () => {
  const { app, runtimeManager } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: {
      name: "Busy session"
    }
  });
  const sessionId = createResponse.json().session.sessionId as string;

  runtimeManager.busySessions.add(sessionId);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: {
      sessionId,
      text: "This should be rejected"
    }
  });

  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({
        error: "session_busy"
      });
});

test("omitted artifact scope leaves the turn unscoped by default", async () => {
  const { app, sessions, runtimeManager, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "Scoped artifacts");
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const form = new FormData();
  form.set("sessionId", session.sessionId);
  form.set("file", new Blob(["Executive summary line one."], { type: "text/plain" }), "document.txt");

  const uploadResponse = await fetch(`${baseUrl}/artifacts`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-user-id": "platform-user"
    },
    body: form
  });
  await uploadResponse.json();

  runtimeManager.queueEvents(session.sessionId, [
    { type: "response.created", responseId: "resp-artifact-default" },
    { type: "response.output_text.delta", responseId: "resp-artifact-default", delta: "Summary" },
    { type: "response.output_item.done", responseId: "resp-artifact-default" },
    { type: "response.completed", responseId: "resp-artifact-default" }
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      sessionId: session.sessionId,
      text: "Summarize the uploaded document."
    }
  });

  expect(response.statusCode).toBe(200);
  const defaultScopedContext = toolContexts.createdContexts.at(-1)?.metadata as {
    selectedArtifactIds: string[];
    runtimePolicy: { id: string };
  };
  expect(defaultScopedContext.selectedArtifactIds).toEqual([]);
  expect(defaultScopedContext.runtimePolicy.id).toBe("tenant-settings:test-tenant");
  expect(runtimeManager.runMessageInputs.at(-1)?.userInputs).toBe(undefined);
});

test("preserves an explicit empty artifact scope on a message turn", async () => {
  const { app, sessions, artifacts, runtimeManager, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "Manual empty scope");
  await artifacts.create({
    artifactType: "upload",
    sessionId: session.sessionId,
    userId: "platform-user",
    artifactName: "notes.txt",
    mimeType: "text/plain",
    storageBackend: "local",
    storageKey: "artifacts/notes.txt",
    fileSizeBytes: 128,
    checksumSha256: "checksum",
    status: "ready",
    createdByType: "user"
  });

  runtimeManager.queueEvents(session.sessionId, [
    { type: "response.created", responseId: "resp-explicit-empty" },
    { type: "response.output_item.done", responseId: "resp-explicit-empty" },
    { type: "response.completed", responseId: "resp-explicit-empty" }
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      sessionId: session.sessionId,
      text: "Reply without using uploaded files.",
      artifactIds: []
    }
  });

  expect(response.statusCode).toBe(200);
  const explicitEmptyScopeContext = toolContexts.createdContexts.at(-1)?.metadata as {
    selectedArtifactIds: string[];
    runtimePolicy: { id: string };
  };
  expect(explicitEmptyScopeContext.selectedArtifactIds).toEqual([]);
  expect(explicitEmptyScopeContext.runtimePolicy.id).toBe("tenant-settings:test-tenant");
  expect(runtimeManager.runMessageInputs.at(-1)?.prompt ?? "").not.toMatch(/Artifact context:/);
});

test("attaches rendered PDF images and extracted text to the runtime turn for summaries", async () => {
  const { app, sessions, artifacts, runtimeManager, toolContexts, artifactProcessor } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "PDF fallback");
  const artifact = await artifacts.create({
    artifactType: "upload",
    sessionId: session.sessionId,
    userId: "platform-user",
    artifactName: "Document 2.pdf",
    mimeType: "application/pdf",
    storageBackend: "local",
    storageKey: "artifacts/document-2.pdf",
    fileSizeBytes: 10_400,
    checksumSha256: "checksum",
    status: "ready",
    createdByType: "user"
  });

  runtimeManager.queueEvents(session.sessionId, [
    { type: "response.created", responseId: "resp-pdf-fallback" },
    { type: "response.output_text.delta", responseId: "resp-pdf-fallback", delta: "Summary body." },
    { type: "response.output_item.done", responseId: "resp-pdf-fallback" },
    { type: "response.completed", responseId: "resp-pdf-fallback" }
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      sessionId: session.sessionId,
      text: "Make a summary.",
      artifactIds: [artifact.artifactId]
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.body).toMatch(/Sources: Document 2\.pdf/);
  const pdfContext = toolContexts.createdContexts.at(-1)?.metadata as {
    selectedArtifactIds: string[];
    runtimePolicy: { id: string };
  };
  expect(pdfContext.selectedArtifactIds).toEqual([
        artifact.artifactId
      ]);
  expect(pdfContext.runtimePolicy.id).toBe("tenant-settings:test-tenant");
  const userInputs = runtimeManager.runMessageInputs.at(-1)?.userInputs ?? [];
  expect(userInputs[0]?.type).toBe("text");
  expect(userInputs[0]?.type === "text" ? userInputs[0].text : "").toMatch(/Document 2\.pdf/);
  expect(userInputs[0]?.type === "text" ? userInputs[0].text : "").toMatch(/Extracted PDF text for testing\./);
  expect(userInputs[0]?.type === "text" ? userInputs[0].text : "").toMatch(/Attached 2 rendered PDF page image\(s\) from: Document 2\.pdf/);
  expect(userInputs.slice(1)).toEqual([
          { type: "localImage", path: "/tmp/document-2-page-1.png" },
          { type: "localImage", path: "/tmp/document-2-page-2.png" }
        ]);
  expect(artifactProcessor.cleanedImageSets).toBe(1);
});

test("deleting a session aborts its runtime", async () => {
  const { app, runtimeManager } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      name: "Disposable session"
    }
  });
  const sessionId = createResponse.json().session.sessionId as string;

  const deleteResponse = await app.inject({
    method: "DELETE",
    url: `/sessions/${sessionId}`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(deleteResponse.statusCode).toBe(204);
  expect(runtimeManager.abortedSessions).toEqual([
        {
          tenantId: "test-tenant",
          sessionId,
          userId: "platform-user"
        }
      ]);
});

test("uploads a user artifact, lists it on the session, and downloads it with a token", async () => {
  const { app, auditEvents } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      name: "Artifact session"
    }
  });
  const sessionId = createResponse.json().session.sessionId as string;
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  const form = new FormData();
  form.set("sessionId", sessionId);
  form.set("file", new Blob(["artifact body"], { type: "text/plain" }), "notes.txt");

  const uploadResponse = await fetch(`${baseUrl}/artifacts`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-user-id": "platform-user"
    },
    body: form
  });

  expect(uploadResponse.status).toBe(201);
  const uploadPayload = await uploadResponse.json();
  const artifactId = uploadPayload.artifact.artifactId as string;
  expect(uploadPayload.artifact.artifactName).toBe("notes.txt");
  expect(uploadPayload.artifact.mimeType).toBe("text/plain");

  const listResponse = await app.inject({
    method: "GET",
    url: `/sessions/${sessionId}/artifacts`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(listResponse.statusCode).toBe(200);
  const listPayload = listResponse.json();
  expect(listPayload.artifacts.length).toBe(1);
  expect(listPayload.artifacts[0].artifactId).toBe(artifactId);
  expect(listPayload.artifacts[0].status).toBe("ready");

  const tokenResponse = await app.inject({
    method: "POST",
    url: `/artifacts/${artifactId}/download-token`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(tokenResponse.statusCode).toBe(200);
  const tokenPayload = tokenResponse.json();
  expect(tokenPayload.download.url as string).toMatch(/^\/downloads\/download-1$/);

  const downloadResponse = await app.inject({
    method: "GET",
    url: tokenPayload.download.url as string,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(downloadResponse.statusCode).toBe(200);
  expect(downloadResponse.headers["content-type"]).toBe("text/plain");
  expect(downloadResponse.body).toBe("artifact body");
  expect(auditEvents.events.filter((event) => event.type === "artifact_uploaded").length).toBe(1);
  expect(auditEvents.events.filter((event) => event.type === "artifact_downloaded").length).toBe(1);
});

test("download token cannot be used by a different user in the same tenant", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-user-id": "user-a" },
    payload: { name: "Artifact session" }
  });
  const sessionId = createResponse.json().session.sessionId as string;
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  const form = new FormData();
  form.set("sessionId", sessionId);
  form.set("file", new Blob(["secret body"], { type: "text/plain" }), "secret.txt");

  const uploadResponse = await fetch(`${baseUrl}/artifacts`, {
    method: "POST",
    headers: { origin: "http://localhost:3000", "x-user-id": "user-a" },
    body: form
  });
  expect(uploadResponse.status).toBe(201);
  const artifactId = (await uploadResponse.json()).artifact.artifactId as string;

  const tokenResponse = await app.inject({
    method: "POST",
    url: `/artifacts/${artifactId}/download-token`,
    headers: { "x-user-id": "user-a" }
  });
  expect(tokenResponse.statusCode).toBe(200);
  const tokenUrl = tokenResponse.json().download.url as string;

  // user-b in the same tenant must not be able to use user-a's token.
  const stolenAttempt = await app.inject({
    method: "GET",
    url: tokenUrl,
    headers: { "x-user-id": "user-b" }
  });
  expect(stolenAttempt.statusCode).toBe(404);

  // user-a (the original owner) can still download.
  const legitimateDownload = await app.inject({
    method: "GET",
    url: tokenUrl,
    headers: { "x-user-id": "user-a" }
  });
  expect(legitimateDownload.statusCode).toBe(200);
  expect(legitimateDownload.body).toBe("secret body");
});

test("download tokens stop working after the backing session is deleted", async () => {
  const { app, sessions } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      name: "Revoked download session"
    }
  });
  const sessionId = createResponse.json().session.sessionId as string;
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  const form = new FormData();
  form.set("sessionId", sessionId);
  form.set("file", new Blob(["artifact body"], { type: "text/plain" }), "notes.txt");

  const uploadResponse = await fetch(`${baseUrl}/artifacts`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-user-id": "platform-user"
    },
    body: form
  });

  expect(uploadResponse.status).toBe(201);
  const uploadPayload = await uploadResponse.json();
  const artifactId = uploadPayload.artifact.artifactId as string;

  const tokenResponse = await app.inject({
    method: "POST",
    url: `/artifacts/${artifactId}/download-token`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(tokenResponse.statusCode).toBe(200);
  const tokenUrl = tokenResponse.json().download.url as string;

  expect(await sessions.remove("test-tenant", sessionId, "platform-user")).toBe(true);

  const downloadResponse = await app.inject({
    method: "GET",
    url: tokenUrl
  });

  expect(downloadResponse.statusCode).toBe(404);
  expect(downloadResponse.json().error).toBe("download_not_found");
});

test("uploads a PDF as a single visible artifact and keeps conversion on demand", async () => {
  const { app, artifacts, auditEvents } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      name: "PDF processing session"
    }
  });
  const sessionId = createResponse.json().session.sessionId as string;
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  const form = new FormData();
  form.set("sessionId", sessionId);
  form.set("file", new Blob(["pdf-binary-placeholder"], { type: "application/pdf" }), "report.pdf");

  const uploadResponse = await fetch(`${baseUrl}/artifacts`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-user-id": "platform-user"
    },
    body: form
  });

  expect(uploadResponse.status).toBe(201);
  const uploadPayload = await uploadResponse.json();
  const sourceArtifactId = uploadPayload.artifact.artifactId as string;
  expect(uploadPayload.artifact.status).toBe("ready");

  const sessionArtifacts = await artifacts.listBySession("test-tenant", sessionId, "platform-user");
  const sourceArtifact = sessionArtifacts.find((artifact) => artifact.artifactId === sourceArtifactId);
  const derivedArtifact = sessionArtifacts.find(
    (artifact) => artifact.artifactType === "derived" && artifact.sourceArtifactId === sourceArtifactId
  );

  expect(sourceArtifact).toBeTruthy();
  expect(sourceArtifact?.status).toBe("ready");
  expect((sourceArtifact?.detail.processing as { state?: string } | undefined)?.state).toBe(undefined);
  expect(derivedArtifact).toBe(undefined);
  const listResponse = await app.inject({
    method: "GET",
    url: `/sessions/${sessionId}/artifacts`,
    headers: {
      "x-user-id": "platform-user"
    }
  });
  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json().artifacts.length).toBe(1);
  expect(listResponse.json().artifacts[0].artifactId).toBe(sourceArtifactId);
  expect(auditEvents.events.filter((event) => event.type === "artifact_uploaded").length).toBe(1);
});

test("creates a generated artifact from an assistant message", async () => {
  const { app, sessions, messages } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "Generated artifact session");
  const assistantMessage = await messages.create({
    tenantId: "test-tenant",
    sessionId: session.sessionId,
    userId: "platform-user",
    role: "assistant",
    status: "completed",
    content: "Report output"
  });

  const response = await app.inject({
    method: "POST",
    url: `/messages/${assistantMessage.messageId}/artifact`,
    headers: {
      "x-user-id": "platform-user"
    },
    payload: {
      name: "report.md"
    }
  });

  expect(response.statusCode).toBe(201);
  expect(response.json().artifact.artifactType).toBe("generated");
  expect(response.json().artifact.artifactName).toBe("report.md");
});

test("lists pending approvals and resolves a decision", async () => {
  const { app, approvals, runtimeManager } = await createTestApp();
  const sessionId = uuidv7();
  onTestFinished(async () => {
        await app.close();
      });

  approvals.approvals.push({
    approvalId: "approval-1",
    sessionId,
    userId: "test-user",
    runtimeId: "runtime-1",
    turnId: "turn-1",
    itemId: "cmd-1",
    requestMethod: "item/commandExecution/requestApproval",
    requestId: "1",
    kind: "command_execution",
    title: "Approve shell command",
    summary: "pwd",
    status: "pending",
    decision: null,
    requestPayload: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null
  });

  const listResponse = await app.inject({
    method: "GET",
    url: `/sessions/${sessionId}/approvals`
  });

  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json().approvals.length).toBe(1);

  const decisionResponse = await app.inject({
    method: "POST",
    url: "/approvals/approval-1/decision",
    payload: {
      decision: "approve"
    }
  });

  expect(decisionResponse.statusCode).toBe(200);
  expect(runtimeManager.resolvedApprovals).toEqual([
        {
          approvalId: "approval-1",
          tenantId: "test-tenant",
          userId: "test-user",
          decision: "approve",
          rememberForTurn: undefined
        }
      ]);
});

test("serves the managed MCP tool and resolves context from toolContextId", async () => {
  const { app, sessions, messages, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "test-user", "Managed MCP");
  await messages.create({
    tenantId: "test-tenant",
    sessionId: session.sessionId,
    userId: "test-user",
    role: "assistant",
    status: "completed",
    content: "Stored assistant message"
  });
  const toolContext = await createTestToolContext(toolContexts, {
    sessionId: session.sessionId
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "session_context",
        arguments: {
          toolContextId: toolContext.toolContextId,
          recentMessageCount: 1
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json();
  expect(payload.result.isError).toBe(false);
  expect(payload.result.structuredContent.session.sessionId).toBe(session.sessionId);
});

test("managed MCP tools/list omits outputSchema", async () => {
  // The Claude Agent SDK's bundled MCP client rejects tools whose
  // `outputSchema` uses a top-level `{ oneOf: [...] }` discriminator and
  // silently drops every tool from the response. We advertise only
  // `inputSchema` so the model actually sees the managed tools.
  const { app } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    }
  });

  expect(response.statusCode).toBe(200);
  const tool = response.json().result.tools.find((entry: { name: string }) => entry.name === "session_context");
  expect(tool).toBeTruthy();
  expect(tool.inputSchema).toBeTruthy();
  expect(tool.outputSchema).toBe(undefined);
});

test("managed MCP tools/list only exposes tools enabled by the active runtime policy", async () => {
  const { app, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const sessionId = "session-filtered-tools";
  await createTestToolContext(toolContexts, {
    sessionId,
    metadata: {
      runtimePolicy: {
        ...phase4RuntimePolicy,
        enabledToolIds: ["session_context", "list_artifacts"],
        enabledMcpServers: ["managed-session-context"]
      }
    }
  });

  const runtimeToken = generateRuntimeToken(
    { sid: sessionId, tid: "test-tenant", uid: "test-user", rid: "runtime-session-filtered-tools" },
    "test-runtime-token-secret"
  );

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    headers: {
      authorization: `Bearer ${runtimeToken}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    }
  });

  expect(response.statusCode).toBe(200);
  const toolNames = response.json().result.tools.map((entry: { name: string }) => entry.name);
  expect(toolNames).toEqual(["session_context", "list_artifacts"]);
});

test("lists and reads scoped text artifacts through the managed MCP server", async () => {
  const { app, sessions, artifacts, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "test-user", "Artifact MCP");
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const form = new FormData();
  form.set("sessionId", session.sessionId);
  form.set("file", new Blob(["artifact text content"], { type: "text/plain" }), "scope.txt");

  const uploadResponse = await fetch(`${baseUrl}/artifacts`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-user-id": "test-user"
    },
    body: form
  });
  const uploadPayload = await uploadResponse.json();
  const artifactId = uploadPayload.artifact.artifactId as string;

  const toolContext = await createTestToolContext(toolContexts, {
    sessionId: session.sessionId,
    userId: "test-user",
    metadata: {
      selectedArtifactIds: [artifactId]
    }
  });

  const listResponse = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_artifacts",
        arguments: {
          toolContextId: toolContext.toolContextId
        }
      }
    }
  });

  expect(listResponse.statusCode).toBe(200);
  expect(listResponse.json().result.structuredContent.artifacts.length).toBe(1);
  expect(listResponse.json().result.structuredContent.artifacts[0].artifactId).toBe(artifactId);

  const readResponse = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "read_text_artifact",
        arguments: {
          toolContextId: toolContext.toolContextId,
          artifactId
        }
      }
    }
  });

  expect(readResponse.statusCode).toBe(200);
  expect(readResponse.json().result.structuredContent.content).toBe("artifact text content");
  expect(await artifacts.getOwned("test-tenant", artifactId, "test-user")).toBeTruthy();
});

test("denies managed MCP tools that are not enabled by the runtime policy", async () => {
  const { app, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const toolContext = await createTestToolContext(toolContexts, {
    runtimePolicyId: "baseline-chat",
    metadata: {
      runtimePolicy: {
        ...phase4RuntimePolicy,
        id: "baseline-chat",
        label: "Baseline chat",
        allowCommandExecution: false,
        allowUserTokenForwarding: false,
        autoApproveReadOnlyTools: false,
        enabledToolIds: ["write_artifact"],
        enabledMcpServers: ["managed-session-context"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "session_context",
        arguments: {
          toolContextId: toolContext.toolContextId
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message:
            "Managed tool session_context is not allowed by runtime policy baseline-chat."
          }
      });
});

test("allows write_artifact through the baseline runtime policy", async () => {
  const { app, artifacts, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const toolContext = await createTestToolContext(toolContexts, {
    runtimePolicyId: "baseline-chat",
    metadata: {
      runtimePolicy: {
        ...phase4RuntimePolicy,
        id: "baseline-chat",
        label: "Baseline chat",
        allowCommandExecution: false,
        allowUserTokenForwarding: false,
        autoApproveReadOnlyTools: false,
        enabledToolIds: ["write_artifact"],
        enabledMcpServers: ["managed-session-context"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "write_artifact",
        arguments: {
          toolContextId: toolContext.toolContextId,
          name: "baseline.txt",
          content: "saved from baseline"
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  const payload = response.json();
  expect(payload.result.isError).toBe(false);
  expect(payload.result.structuredContent.artifactName).toBe("baseline.txt");

  const artifactId = String(payload.result.structuredContent.artifactId);
  const artifact = await artifacts.getOwned("test-tenant", artifactId, "test-user");
  expect(artifact).toBeTruthy();
  expect(artifact.artifactName).toBe("baseline.txt");
});

test("surfaces managed MCP broker errors as JSON-RPC failures", async () => {
  const { app, toolContexts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const toolContext = await createTestToolContext(toolContexts, {
    sessionId: uuidv7()
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/managed-session-context",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "session_context",
        arguments: {
          toolContextId: toolContext.toolContextId
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: "Session not found for tool context."
        }
      });
});

test("forwards proxy MCP calls with validated context headers", async () => {
  const { upstream, upstreamUrl, upstreamRequests } = await createProxyMcpUpstream();
  const { app, toolContexts } = await createTestApp({
    proxyUpstreamUrl: `${upstreamUrl}/`
  });
  onTestFinished(async () => {
        await Promise.all([app.close(), upstream.close()]);
      });

  const toolContext = await createTestToolContext(toolContexts, {
    metadata: {
      runtimePolicy: {
        ...phase4RuntimePolicy,
        enabledMcpServers: [...phase4RuntimePolicy.enabledMcpServers, "test-proxy"],
        enabledToolIds: [...phase4RuntimePolicy.enabledToolIds, "test-proxy"]
      }
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/mcp/test-proxy",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: {
          toolContextId: toolContext.toolContextId,
          query: "session summary"
        }
      }
    }
  });

  expect(response.statusCode).toBe(200);
  expect(upstreamRequests.length).toBe(1);
  expect(response.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: false,
          structuredContent: {
            echoedArguments: {
              query: "session summary"
            }
          }
        }
      });
  expect(upstreamRequests[0].body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {
            query: "session summary"
          }
        }
      });
  expect(upstreamRequests[0].headers["x-framework-user-id"]).toBe("test-user");
  expect(upstreamRequests[0].headers["x-framework-session-id"]).toBe("session-1");
  expect(upstreamRequests[0].headers["x-framework-runtime-id"]).toBe("runtime-session-1");

  // Signature must be present and verifiable using the framework's secret.
  const { verifyProxyHeaders } = await import("../lib/mcp-proxy-signature.js");
  const { createTestConfig } = await import("../test-helpers/test-config.js");
  const verified = verifyProxyHeaders(
    upstreamRequests[0].headers,
    createTestConfig().DATA_ENCRYPTION_SECRET,
    { maxAgeMs: 60_000 }
  );
  expect(verified.ok).toBe(true);
});

test("rejects invalid message payloads with a 400 response", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const response = await app.inject({
    method: "POST",
    url: "/messages",
    payload: {
      sessionId: "not-a-uuid",
      text: ""
    }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
        error: "invalid_request",
        details: [
          {
            path: "sessionId",
            message: "Invalid UUID"
          },
          {
            path: "text",
            message: "Too small: expected string to have >=1 characters"
          }
        ]
      });
});

test("rejects invalid session payloads with a 400 response", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    payload: {
      name: ""
    }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
        error: "invalid_request",
        details: [
          {
            path: "name",
            message: "Too small: expected string to have >=1 characters"
          }
        ]
      });
});

test("allows CORS preflight for tenant-scoped session requests", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const response = await app.inject({
    method: "OPTIONS",
    url: "/sessions",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "GET",
      "access-control-request-headers": "X-User-Id, X-Tenant-Id"
    }
  });

  expect(response.statusCode).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  expect(String(response.headers["access-control-allow-headers"] ?? "")).toMatch(/X-Tenant-Id/i);
});

test("rate limits session creation per user with a structured 429 response", async () => {
  const { app } = await createTestApp({
    SESSION_CREATE_LIMIT_PER_USER_PER_WINDOW: 1
  });
  onTestFinished(async () => {
        await app.close();
      });

  const first = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: {
      "x-user-id": "platform-user",
      "x-tenant-id": "tenant-a"
    },
    payload: {
      name: "First"
    }
  });
  expect(first.statusCode).toBe(201);

  const second = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: {
      "x-user-id": "platform-user",
      "x-tenant-id": "tenant-a"
    },
    payload: {
      name: "Second"
    }
  });

  expect(second.statusCode).toBe(429);
  expect(second.json().error).toBe("limit_exceeded");
  expect(second.json().limitType).toBe("rate_limit");
  expect(second.json().scope).toBe("user");
  expect(second.json().resource).toBe("session_create");
});

test("rate limits message turns per tenant before runtime execution starts", async () => {
  const { app, sessions, runtimeManager } = await createTestApp({
    MESSAGE_LIMIT_PER_TENANT_PER_WINDOW: 1
  });
  onTestFinished(async () => {
        await app.close();
      });

  const sessionA = await sessions.create("test-tenant", "user-a", "Tenant limited A");
  const sessionB = await sessions.create("test-tenant", "user-b", "Tenant limited B");

  runtimeManager.queueEvents(sessionA.sessionId, [
    { type: "response.created", responseId: "resp-tenant-1" },
    { type: "response.completed", responseId: "resp-tenant-1" }
  ]);

  const first = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "user-a",
      "x-tenant-id": "tenant-shared"
    },
    payload: {
      sessionId: sessionA.sessionId,
      text: "First tenant-scoped message."
    }
  });
  expect(first.statusCode).toBe(200);

  const second = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "user-b",
      "x-tenant-id": "tenant-shared"
    },
    payload: {
      sessionId: sessionB.sessionId,
      text: "Second tenant-scoped message."
    }
  });

  expect(second.statusCode).toBe(429);
  expect(second.json().error).toBe("limit_exceeded");
  expect(second.json().scope).toBe("tenant");
  expect(second.json().resource).toBe("message_turn");
  expect(runtimeManager.runMessageInputs.length).toBe(1);
});

test("enforces daily per-user turn quotas before runtime execution starts", async () => {
  const { app, sessions, runtimeManager, messages } = await createTestApp({
    TURN_QUOTA_PER_USER_PER_DAY: 1
  });
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("tenant-a", "quota-user", "Quota limited");

  runtimeManager.queueEvents(session.sessionId, [
    { type: "response.created", responseId: "resp-quota-1" },
    { type: "response.completed", responseId: "resp-quota-1" }
  ]);

  const first = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "quota-user",
      "x-tenant-id": "tenant-a"
    },
    payload: {
      sessionId: session.sessionId,
      text: "First quota-counted message."
    }
  });
  expect(first.statusCode).toBe(200);

  const messageCountBefore = (await messages.listBySession("tenant-a", session.sessionId, "quota-user")).length;
  const second = await app.inject({
    method: "POST",
    url: "/messages",
    headers: {
      "x-user-id": "quota-user",
      "x-tenant-id": "tenant-a"
    },
    payload: {
      sessionId: session.sessionId,
      text: "Second quota-counted message."
    }
  });

  expect(second.statusCode).toBe(429);
  expect(second.json().error).toBe("limit_exceeded");
  expect(second.json().limitType).toBe("usage_quota");
  expect(second.json().scope).toBe("user");
  const messageCountAfter = (await messages.listBySession("tenant-a", session.sessionId, "quota-user")).length;
  expect(messageCountAfter).toBe(messageCountBefore);
  expect(runtimeManager.runMessageInputs.length).toBe(1);
});

test("GET /models returns the hardcoded model list", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => { await app.close(); });

  const response = await app.inject({
    method: "GET",
    url: "/models",
    headers: { "x-user-id": "platform-user" }
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    models: Array<{ id: string; displayName: string; description: string; isDefault: boolean; provider: string; supportedEfforts: string[] }>;
    enabledRuntimeProviders: string[];
    defaultRuntimeProvider: string;
    showEffortSelector: boolean;
  };
  expect(Array.isArray(body.models)).toBeTruthy();
  expect(body.models.length > 0).toBeTruthy();
  expect(body.enabledRuntimeProviders).toEqual(["codex"]);
  expect(body.defaultRuntimeProvider).toBe("codex");
  expect(body.showEffortSelector).toBe(false);
  const defaultModel = body.models.find((m) => m.isDefault);
  expect(defaultModel).toBeTruthy();
  expect(defaultModel.id).toBe("gpt-5.4-mini");
  expect(defaultModel.supportedEfforts).toEqual(["none", "low", "medium", "high", "xhigh"]);
});

test("GET /models returns both provider families when both are enabled", async () => {
  const { app } = await createTestApp({
    tenantRuntimeProvider: "claude-code",
    enabledRuntimeProviders: ["codex", "claude-code"]
  });
  onTestFinished(async () => { await app.close(); });

  const response = await app.inject({
    method: "GET",
    url: "/models",
    headers: { "x-user-id": "platform-user" }
  });

  expect(response.statusCode).toBe(200);
  const body = response.json() as {
    models: Array<{ id: string; provider: string; isDefault: boolean }>;
    enabledRuntimeProviders: string[];
    defaultRuntimeProvider: string;
    showEffortSelector: boolean;
  };
  expect(body.enabledRuntimeProviders).toEqual(["codex", "claude-code"]);
  expect(body.defaultRuntimeProvider).toBe("claude-code");
  expect(body.showEffortSelector).toBe(false);
  expect(body.models[0]?.provider).toBe("claude-code");
  expect(body.models.some((model) => model.provider === "codex")).toBeTruthy();
  expect(body.models.some((model) => model.provider === "claude-code")).toBeTruthy();
});

test("POST /messages accepts optional model override", async () => {
  const { app, runtimeManager } = await createTestApp();
  onTestFinished(async () => { await app.close(); });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-user-id": "platform-user" },
    payload: { name: "model-override-test" }
  });
  const { session } = createResponse.json() as { session: { sessionId: string } };

  runtimeManager.queueEvents(session.sessionId, [
    { type: "response.created", responseId: "resp-1" },
    { type: "response.completed", responseId: "resp-1", status: "completed", tokenUsage: undefined, costUsd: undefined, modelName: "gpt-5.2" }
  ]);

  const msgResponse = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId: session.sessionId, text: "hello", model: "gpt-5.2" }
  });

  expect(msgResponse.statusCode).toBe(200);
  expect(runtimeManager.runMessageInputs.at(-1)?.model).toBe("gpt-5.2");
});

test("POST /messages forwards an effort override when the model supports it", async () => {
  const { app, runtimeManager } = await createTestApp();
  onTestFinished(async () => { await app.close(); });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-user-id": "platform-user" },
    payload: { name: "effort-override-test" }
  });
  const { session } = createResponse.json() as { session: { sessionId: string } };

  runtimeManager.queueEvents(session.sessionId, [
    { type: "response.created", responseId: "resp-effort" },
    { type: "response.completed", responseId: "resp-effort" }
  ]);

  const msgResponse = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId: session.sessionId, text: "hello", model: "gpt-5.4", effort: "xhigh" }
  });

  expect(msgResponse.statusCode).toBe(200);
  expect(runtimeManager.runMessageInputs.at(-1)?.effort).toBe("xhigh");
});

test("POST /messages rejects an unsupported effort for the selected model", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => { await app.close(); });

  const createResponse = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-user-id": "platform-user" },
    payload: { name: "invalid-effort-test" }
  });
  const { session } = createResponse.json() as { session: { sessionId: string } };

  const msgResponse = await app.inject({
    method: "POST",
    url: "/messages",
    headers: { "x-user-id": "platform-user" },
    payload: { sessionId: session.sessionId, text: "hello", model: "gpt-5.1-codex-mini", effort: "xhigh" }
  });

  expect(msgResponse.statusCode).toBe(400);
  expect(msgResponse.body).toMatch(/gpt-5\.1-codex-mini/);
});

test("GET /artifacts/:id/preview-text returns extracted text for a ready PDF artifact", async () => {
  const { app, sessions, artifacts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "Preview text session");

  const artifact = await artifacts.create({
    artifactType: "upload",
    sessionId: session.sessionId,
    userId: "platform-user",
    artifactName: "document.pdf",
    mimeType: "application/pdf",
    storageBackend: "local",
    storageKey: "platform-user/session/document.pdf",
    fileSizeBytes: 1024,
    checksumSha256: "abc123",
    status: "ready",
    createdByType: "user"
  });

  const response = await app.inject({
    method: "GET",
    url: `/artifacts/${artifact.artifactId}/preview-text`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().text).toBe("Extracted PDF text for testing.");
});

test("GET /artifacts/:id/preview-text returns 422 for a non-PDF artifact", async () => {
  const { app, sessions, artifacts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "Preview text non-pdf session");

  const artifact = await artifacts.create({
    artifactType: "upload",
    sessionId: session.sessionId,
    userId: "platform-user",
    artifactName: "notes.txt",
    mimeType: "text/plain",
    storageBackend: "local",
    storageKey: "platform-user/session/notes.txt",
    fileSizeBytes: 512,
    checksumSha256: "def456",
    status: "ready",
    createdByType: "user"
  });

  const response = await app.inject({
    method: "GET",
    url: `/artifacts/${artifact.artifactId}/preview-text`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(response.statusCode).toBe(422);
  expect(response.json().error).toBe("not_a_pdf");
});

test("GET /artifacts/:id/preview-text returns 404 for unknown artifact", async () => {
  const { app } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const response = await app.inject({
    method: "GET",
    url: `/artifacts/00000000-0000-0000-0000-000000000000/preview-text`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(response.statusCode).toBe(404);
  expect(response.json().error).toBe("artifact_not_found");
});

test("GET /artifacts/:id/preview-text returns 422 artifact_not_ready for a pending PDF artifact", async () => {
  const { app, sessions, artifacts } = await createTestApp();
  onTestFinished(async () => {
        await app.close();
      });

  const session = await sessions.create("test-tenant", "platform-user", "Preview text pending session");

  const artifact = await artifacts.create({
    artifactType: "upload",
    sessionId: session.sessionId,
    userId: "platform-user",
    artifactName: "document.pdf",
    mimeType: "application/pdf",
    storageBackend: "local",
    storageKey: "platform-user/session/document.pdf",
    fileSizeBytes: 1024,
    checksumSha256: "abc123",
    status: "pending",
    createdByType: "user"
  });

  const response = await app.inject({
    method: "GET",
    url: `/artifacts/${artifact.artifactId}/preview-text`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(response.statusCode).toBe(422);
  expect(response.json().error).toBe("artifact_not_ready");
});

test("GET /artifacts/:id/preview-text returns 422 pdf_extraction_failed when processor returns null", async () => {
  const artifactStorageRoot = await mkdtemp(path.join(os.tmpdir(), "cogniplane-pdf-extract-null-test-"));
  const artifactId = uuidv7();
  const nullProcessor = { async extractArtifactText() { return null; } };
  const artifactRecord = {
    id: 1,
    artifactId,
    artifactType: "upload" as const,
    sessionId: "session-null",
    userId: "platform-user",
    sourceArtifactId: null,
    artifactName: "broken.pdf",
    mimeType: "application/pdf",
    storageBackend: "local" as const,
    storageKey: "platform-user/session-null/broken.pdf",
    fileSizeBytes: 512,
    checksumSha256: "deadbeef",
    status: "ready" as const,
    createdByType: "user" as const,
    createdByRef: null,
    detail: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const stubStores = {
    sessions: { async getOwned() { return null; } },
    messages: { async getOwned() { return null; } },
    artifacts: {
      async getOwned(_tenantId: string, id: string, userId: string) {
        return id === artifactId && userId === "platform-user" ? artifactRecord : null;
      },
      async create() { return artifactRecord; },
      async listBySession() { return []; },
      async createDownloadToken() { return null as never; },
      async consumeDownloadToken() { return null; }
    },
    auditEvents: new InMemoryAuditEventStore(),
    storage: new LocalArtifactStorage(artifactStorageRoot),
    processor: nullProcessor
  };
  const app = Fastify();
  await app.register(multipart);
  app.addHook("preHandler", async (request) => {
    request.auth = { userId: "platform-user", tenantId: "test-tenant", isAdmin: true, role: "owner" as const };
  });
  await registerArtifactRoutes(app, stubStores);
  await app.ready();

  onTestFinished(async () => {
        await app.close();
        await rm(artifactStorageRoot, { recursive: true, force: true });
      });

  const response = await app.inject({
    method: "GET",
    url: `/artifacts/${artifactId}/preview-text`,
    headers: {
      "x-user-id": "platform-user"
    }
  });

  expect(response.statusCode).toBe(422);
  expect(response.json().error).toBe("pdf_extraction_failed");
});
