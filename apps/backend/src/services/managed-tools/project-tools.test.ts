import { Readable } from "node:stream";
import { test, expect, vi } from "vitest";

import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import type { ProjectRuntimeFileSnapshot } from "../project-file-store.js";

import { createProjectTools } from "./project-tools.js";

function context(metadata: Record<string, unknown> = {}): ToolExecutionContext {
  return {
    toolContextId: "ctx-1",
    tenantId: "tenant-1",
    sessionId: "session-1",
    userId: "user-1",
    runtimeId: "runtime-1",
    runtimePolicyId: "default",
    messageId: "message-1",
    credentialEnvelope: {},
    metadata,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    createdAt: new Date().toISOString()
  };
}

const snapshot: ProjectRuntimeFileSnapshot = {
  projectId: "project-1",
  capturedAt: "2026-09-15T12:00:00.000Z",
  truncated: false,
  files: [
    {
      fileId: "file-1",
      versionId: "version-1",
      versionNumber: 3,
      folderId: null,
      name: "README.md",
      mimeType: "text/markdown",
      kind: "published",
      selected: true
    },
    {
      fileId: "draft-1",
      versionId: "draft-version-1",
      versionNumber: 1,
      folderId: "folder-1",
      name: "notes.md",
      mimeType: "text/markdown",
      kind: "draft",
      selected: false
    }
  ]
};

function projectContext(mode: "read-only" | "create-only" | "read-write" = "read-only") {
  return { projectContext: { projectId: snapshot.projectId, agentFileMode: mode, snapshot } };
}

function tool(tools: ReturnType<typeof createProjectTools>, name: string) {
  const definition = tools.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing project tool: ${name}`);
  return definition;
}

test("project_list_files returns the captured published files and selected drafts", async () => {
  const tools = createProjectTools({
    projectFiles: {
      readRuntimeSnapshotFile: vi.fn(),
      createAgentDraftFromContent: vi.fn(),
      readConflictContext: vi.fn(),
      readConflictMetadata: vi.fn()
    },
    storage: {
      openReadStream: vi.fn(),
      put: vi.fn(),
      delete: vi.fn()
    },
    maxProjectFileBytes: 10_000_000
  });

  const result = await tool(tools, "project_list_files").handler({ context: context(projectContext()), arguments: {} });

  expect(result.files).toEqual(snapshot.files);
});

test("project_read_file reads the exact version captured for the turn", async () => {
  const readRuntimeSnapshotFile = vi.fn().mockResolvedValue({
    name: "README.md",
    mimeType: "text/markdown",
    stream: { stream: Readable.from(["stable contents"]) }
  });
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile, createAgentDraftFromContent: vi.fn(), readConflictContext: vi.fn(), readConflictMetadata: vi.fn() },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  const result = await tool(tools, "project_read_file").handler({
    context: context(projectContext()),
    arguments: { fileId: "file-1" }
  });

  expect(result).toMatchObject({
    fileId: "file-1",
    versionId: "version-1",
    versionNumber: 3,
    content: "stable contents",
    truncated: false
  });
  expect(readRuntimeSnapshotFile).toHaveBeenCalledWith(expect.objectContaining({
    fileId: "file-1",
    snapshot,
    sessionId: "session-1",
    messageId: "message-1"
  }));
});

test("project_read_file rejects files outside the captured snapshot", async () => {
  const tools = createProjectTools({
    projectFiles: {
      readRuntimeSnapshotFile: vi.fn(),
      createAgentDraftFromContent: vi.fn(),
      readConflictContext: vi.fn(),
      readConflictMetadata: vi.fn()
    },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_read_file").handler({
    context: context(projectContext()),
    arguments: { fileId: "not-in-snapshot" }
})).rejects.toThrow(/not available in this turn/);
});

test("project_read_file rejects unsupported MIME types before opening the stream", async () => {
  const readRuntimeSnapshotFile = vi.fn();
  const unsupportedSnapshot = {
    ...snapshot,
    files: [{ ...snapshot.files[0]!, mimeType: "application/pdf" }, snapshot.files[1]!]
  };
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile, createAgentDraftFromContent: vi.fn(), readConflictContext: vi.fn(), readConflictMetadata: vi.fn() },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_read_file").handler({
    context: context({
      projectContext: { projectId: snapshot.projectId, agentFileMode: "read-only", snapshot: unsupportedSnapshot }
    }),
    arguments: { fileId: "file-1" }
  })).rejects.toThrow(/not a supported text format/);
  expect(readRuntimeSnapshotFile).not.toHaveBeenCalled();
});

test("project_read_file reports truncation only when content exceeds the limit", async () => {
  const readRuntimeSnapshotFile = vi.fn().mockResolvedValue({
    name: "README.md",
    mimeType: "text/markdown",
    stream: { stream: Readable.from(["12345"]) }
  });
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile, createAgentDraftFromContent: vi.fn(), readConflictContext: vi.fn(), readConflictMetadata: vi.fn() },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_read_file").handler({
    context: context(projectContext()),
    arguments: { fileId: "file-1", maxChars: 5 }
  })).resolves.toMatchObject({ content: "12345", truncated: false });

  readRuntimeSnapshotFile.mockResolvedValue({
    name: "README.md",
    mimeType: "text/markdown",
    stream: { stream: Readable.from(["123456"]) }
  });
  await expect(tool(tools, "project_read_file").handler({
    context: context(projectContext()),
    arguments: { fileId: "file-1", maxChars: 5 }
  })).resolves.toMatchObject({ content: "12345", truncated: true });
});

test("project_read_file keeps a code point intact at the read limit", async () => {
  const readRuntimeSnapshotFile = vi.fn().mockResolvedValue({
    name: "README.md",
    mimeType: "text/markdown",
    stream: { stream: Readable.from([Buffer.from("ab😀def")]) }
  });
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile, createAgentDraftFromContent: vi.fn(), readConflictContext: vi.fn(), readConflictMetadata: vi.fn() },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_read_file").handler({
    context: context(projectContext()),
    arguments: { fileId: "file-1", maxChars: 3 }
  })).resolves.toMatchObject({ content: "ab😀", truncated: true });

  readRuntimeSnapshotFile.mockResolvedValue({
    name: "README.md",
    mimeType: "text/markdown",
    stream: { stream: Readable.from([Buffer.from("ab😀")]) }
  });
  await expect(tool(tools, "project_read_file").handler({
    context: context(projectContext()),
    arguments: { fileId: "file-1", maxChars: 3 }
  })).resolves.toMatchObject({ content: "ab😀", truncated: false });
});

test("project_get_conflict_context requires a selected draft and returns all text versions", async () => {
  const readConflictContext = vi.fn().mockResolvedValue({
    draftId: "draft-1",
    targetFileId: "file-1",
    name: "README.md",
    mimeType: "text/markdown",
    baseVersionId: "version-1",
    baseVersionNumber: 3,
    latestVersionId: "version-2",
    latestVersionNumber: 4,
    baseContent: "base",
    latestContent: "latest",
    proposedContent: "proposed"
  });
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile: vi.fn(), createAgentDraftFromContent: vi.fn(), readConflictContext, readConflictMetadata: readConflictContext },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_get_conflict_context").handler({
    context: context(projectContext()),
    arguments: { draftId: "draft-1" }
  })).rejects.toThrow(/Select this project draft/);

  const selectedSnapshot = {
    ...snapshot,
    files: snapshot.files.map((file) => file.fileId === "draft-1" ? { ...file, selected: true } : file)
  };
  await expect(tool(tools, "project_get_conflict_context").handler({
    context: context({ projectContext: { ...projectContext().projectContext, snapshot: selectedSnapshot } }),
    arguments: { draftId: "draft-1" }
  })).resolves.toMatchObject({ latestContent: "latest" });
  expect(readConflictContext).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft-1" }));
});

test("project_reconcile_conflict creates a new draft from the latest version", async () => {
  const readConflictMetadata = vi.fn().mockResolvedValue({
    draftId: "draft-1",
    targetFileId: "file-1",
    name: "README.md",
    folderId: "folder-1",
    mimeType: "text/markdown",
    baseVersionId: "version-1",
    baseVersionNumber: 3,
    latestVersionId: "version-2",
    latestVersionNumber: 4,
  });
  const readConflictContext = vi.fn();
  const createAgentDraftFromContent = vi.fn().mockResolvedValue({
    fileId: "draft-2",
    name: "README.md",
    targetFileId: "file-1",
    baseVersionId: "version-2"
  });
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile: vi.fn(), createAgentDraftFromContent, readConflictContext, readConflictMetadata },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });
  const selectedSnapshot = {
    ...snapshot,
    files: snapshot.files.map((file) => file.fileId === "draft-1" ? { ...file, selected: true } : file)
  };

  await expect(tool(tools, "project_reconcile_conflict").handler({
    context: context({ projectContext: { projectId: "project-1", agentFileMode: "read-write", snapshot: selectedSnapshot } }),
    arguments: { draftId: "draft-1", content: "merged" }
  })).resolves.toEqual({
    draftId: "draft-2",
    name: "README.md",
    targetFileId: "file-1",
    baseVersionId: "version-2",
    status: "draft"
  });
  expect(createAgentDraftFromContent).toHaveBeenCalledWith(expect.objectContaining({
    targetFileId: "file-1",
    baseVersionId: "version-2",
    folderId: "folder-1",
    content: expect.any(Uint8Array)
  }));
  expect(readConflictMetadata).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft-1" }));
  expect(readConflictContext).not.toHaveBeenCalled();
});

test("project_reconcile_conflict validates content before reading conflict versions", async () => {
  const readConflictContext = vi.fn();
  const createAgentDraftFromContent = vi.fn();
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile: vi.fn(), createAgentDraftFromContent, readConflictContext, readConflictMetadata: readConflictContext },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 5
  });
  const selectedSnapshot = {
    ...snapshot,
    files: snapshot.files.map((file) => file.fileId === "draft-1" ? { ...file, selected: true } : file)
  };
  const projectContext = { projectContext: { projectId: "project-1", agentFileMode: "read-write" as const, snapshot: selectedSnapshot } };

  await expect(tool(tools, "project_reconcile_conflict").handler({
    context: context(projectContext),
    arguments: { draftId: "draft-1", content: "" }
  })).rejects.toThrow("content is required");
  await expect(tool(tools, "project_reconcile_conflict").handler({
    context: context(projectContext),
    arguments: { draftId: "draft-1", content: "123456" }
  })).rejects.toThrow(/configured project-file size limit/);
  expect(readConflictContext).not.toHaveBeenCalled();
  expect(createAgentDraftFromContent).not.toHaveBeenCalled();
});

test("project_reconcile_conflict preserves a non-empty whitespace-only merge", async () => {
  const readConflictContext = vi.fn().mockResolvedValue({
    draftId: "draft-1",
    targetFileId: "file-1",
    name: "README.md",
    folderId: null,
    mimeType: "text/markdown",
    baseVersionId: "version-1",
    baseVersionNumber: 3,
    latestVersionId: "version-2",
    latestVersionNumber: 4,
    baseContent: "base",
    latestContent: "latest",
    proposedContent: "proposed"
  });
  const createAgentDraftFromContent = vi.fn().mockResolvedValue({
    fileId: "draft-2",
    name: "README.md",
    targetFileId: "file-1",
    baseVersionId: "version-2"
  });
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile: vi.fn(), createAgentDraftFromContent, readConflictContext, readConflictMetadata: readConflictContext },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000
  });
  const selectedSnapshot = {
    ...snapshot,
    files: snapshot.files.map((file) => file.fileId === "draft-1" ? { ...file, selected: true } : file)
  };

  await expect(tool(tools, "project_reconcile_conflict").handler({
    context: context({ projectContext: { projectId: "project-1", agentFileMode: "read-write", snapshot: selectedSnapshot } }),
    arguments: { draftId: "draft-1", content: "  \n" }
  })).resolves.toMatchObject({ status: "draft" });
  expect(createAgentDraftFromContent).toHaveBeenCalledWith(expect.objectContaining({
    content: new TextEncoder().encode("  \n")
  }));
});

test("project_write_file creates a draft with the requested target and base version", async () => {
  const createAgentDraftFromContent = vi.fn().mockResolvedValue({
    fileId: "draft-2",
    name: "README.md",
    targetFileId: "file-1",
    baseVersionId: "version-1"
  });
  const tools = createProjectTools({
    projectFiles: {
      readRuntimeSnapshotFile: vi.fn(),
      createAgentDraftFromContent,
      readConflictContext: vi.fn(),
      readConflictMetadata: vi.fn()
    },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  const result = await tool(tools, "project_write_file").handler({
    context: context(projectContext("read-write")),
    arguments: {
      name: "README.md",
      content: "proposed update",
      targetFileId: "file-1",
      baseVersionId: "version-1"
    }
  });

  expect(result).toEqual({
    draftId: "draft-2",
    name: "README.md",
    targetFileId: "file-1",
    baseVersionId: "version-1",
    status: "draft"
  });
  expect(createAgentDraftFromContent).toHaveBeenCalledWith(expect.objectContaining({
    actor: { tenantId: "tenant-1", userId: "user-1", projectId: "project-1" },
    targetFileId: "file-1",
    baseVersionId: "version-1",
    mimeType: "text/markdown",
    content: expect.any(Uint8Array)
  }));
});

test("project_write_file explains read-only mode before calling the store", async () => {
  const createAgentDraftFromContent = vi.fn();
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile: vi.fn(), createAgentDraftFromContent, readConflictContext: vi.fn(), readConflictMetadata: vi.fn() },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_write_file").handler({
    context: context(projectContext("read-only")),
    arguments: { name: "notes.md", content: "not allowed" }
  })).rejects.toThrow(/file mode is read-only/);
  expect(createAgentDraftFromContent).not.toHaveBeenCalled();
});

test("project_write_file explains when content and filePath are both absent", async () => {
  const createAgentDraftFromContent = vi.fn();
  const tools = createProjectTools({
    projectFiles: { readRuntimeSnapshotFile: vi.fn(), createAgentDraftFromContent, readConflictContext: vi.fn(), readConflictMetadata: vi.fn() },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_write_file").handler({
    context: context(projectContext("create-only")),
    arguments: { name: "notes.md" }
  })).rejects.toThrow(/Either content or filePath is required/);
  expect(createAgentDraftFromContent).not.toHaveBeenCalled();
});

test("project tools require a project runtime context", async () => {
  const tools = createProjectTools({
    projectFiles: {
      readRuntimeSnapshotFile: vi.fn(),
      createAgentDraftFromContent: vi.fn(),
      readConflictContext: vi.fn(),
      readConflictMetadata: vi.fn()
    },
    storage: { openReadStream: vi.fn(), put: vi.fn(), delete: vi.fn() },
    maxProjectFileBytes: 10_000_000
  });

  await expect(tool(tools, "project_list_files").handler({ context: context(), arguments: {} })).rejects.toThrow(/not connected to a project/);
});
