import { isTextReadableArtifact, readStreamAsBoundedText } from "../artifacts/artifact-helpers.js";
import type { ArtifactStorage } from "../artifacts/artifact-storage.js";
import type { ArtifactRecord, ArtifactStore } from "../artifacts/artifact-store.js";
import type { MessageStore } from "../message-store.js";
import type { SessionStore } from "../session-store.js";
import type { ToolExecutionContext } from "../auth/tool-execution-context-store.js";
import { ToolCallError } from "../../lib/tool-call-error.js";
import { allRequiredObjectSchema, arraySchema, type ManagedToolDefinition } from "./types.js";

type SessionToolDeps = {
  sessions: Pick<SessionStore, "getReadable">;
  messages: Pick<MessageStore, "listBySession">;
  artifacts: Pick<ArtifactStore, "getReadable" | "listBySession" | "findLatestReadableDerived">;
  storage: Pick<ArtifactStorage, "openReadStream">;
};

// ── Catalog entries (static metadata consumed by ./catalog) ──────────────────

export const SESSION_TOOL_CATALOG: ReadonlyArray<{
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: "session_context",
    description: "Return the current session metadata and a small recent message window.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        recentMessageCount: { type: "integer", minimum: 1, maximum: 10 }
      },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "list_artifacts",
    description: "List artifacts available in the current session context.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" }
      },
      required: ["toolContextId"],
      additionalProperties: false
    }
  },
  {
    name: "read_text_artifact",
    description: "Read the text content of a session artifact when its MIME type is text-readable.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        toolContextId: { type: "string" },
        artifactId: { type: "string" },
        maxChars: { type: "integer", minimum: 1, maximum: 20000 }
      },
      required: ["toolContextId", "artifactId"],
      additionalProperties: false
    }
  }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getScopedArtifactIds(context: ToolExecutionContext): string[] | null {
  const selected = context.metadata.selectedArtifactIds;
  if (!Array.isArray(selected)) return null;
  return selected.filter((entry): entry is string => typeof entry === "string");
}

async function resolveReadableArtifact(input: {
  artifacts: Pick<ArtifactStore, "getReadable" | "findLatestReadableDerived">;
  context: ToolExecutionContext;
  artifactId: string;
}): Promise<ArtifactRecord> {
  const artifact = await input.artifacts.getReadable(input.context.tenantId, input.artifactId, input.context.userId);
  if (!artifact || artifact.sessionId !== input.context.sessionId || artifact.status !== "ready") {
    throw new ToolCallError("Artifact not found for tool context.");
  }

  const scopedArtifactIds = getScopedArtifactIds(input.context);
  if (scopedArtifactIds && scopedArtifactIds.length && !scopedArtifactIds.includes(input.artifactId)) {
    throw new ToolCallError("Artifact is outside the selected artifact scope for this turn.");
  }

  if (isTextReadableArtifact(artifact.mimeType)) return artifact;

  const derivedArtifact = await input.artifacts.findLatestReadableDerived(
    input.context.tenantId,
    artifact.artifactId,
    input.context.userId
  );
  if (!derivedArtifact) {
    throw new ToolCallError(`Artifact ${artifact.artifactName} is not a text-readable MIME type.`);
  }
  return derivedArtifact;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export function createSessionTools(deps: SessionToolDeps): ManagedToolDefinition[] {
  return [
    {
      ...SESSION_TOOL_CATALOG[0], // session_context
      outputSchema: allRequiredObjectSchema({
        session: allRequiredObjectSchema({
          sessionId: { type: "string" },
          sessionName: { type: "string" },
          status: { type: "string" }
        }),
        recentMessages: arraySchema(
          allRequiredObjectSchema({
            role: { type: "string" },
            status: { type: "string" },
            content: { type: "string" }
          })
        ),
        runtimePolicyId: { type: "string" }
      }),
      handler: async ({ context, arguments: args }) => {
        const session = await deps.sessions.getReadable(context.tenantId, context.sessionId, context.userId);
        if (!session || session.status !== "active") {
          throw new ToolCallError("Session not found for tool context.");
        }

        const recentMessageCount = Math.max(1, Math.min(10, Number(args.recentMessageCount ?? 4) || 4));
        // Only the newest `recentMessageCount` are returned, so ask the store for
        // exactly those instead of pulling the whole transcript to slice its tail.
        const { messages } = await deps.messages.listBySession(
          context.tenantId,
          context.sessionId,
          context.userId,
          { limit: recentMessageCount }
        );

        return {
          session: {
            sessionId: session.sessionId,
            sessionName: session.sessionName,
            status: session.status
          },
          recentMessages: messages.slice(-recentMessageCount).map((message) => ({
            role: message.role,
            status: message.status,
            content: message.content
          })),
          runtimePolicyId: context.runtimePolicyId
        };
      }
    },

    {
      ...SESSION_TOOL_CATALOG[1], // list_artifacts
      outputSchema: allRequiredObjectSchema({
        artifacts: arraySchema(
          allRequiredObjectSchema({
            artifactId: { type: "string" },
            artifactType: { type: "string" },
            artifactName: { type: "string" },
            mimeType: { type: "string" },
            status: { type: "string" },
            sourceArtifactId: { type: ["string", "null"] },
            createdAt: { type: "string" }
          })
        )
      }),
      handler: async ({ context }) => {
        const session = await deps.sessions.getReadable(context.tenantId, context.sessionId, context.userId);
        if (!session || session.status !== "active") {
          throw new ToolCallError("Session not found for tool context.");
        }

        const scopedArtifactIds = getScopedArtifactIds(context);
        const artifacts = await deps.artifacts.listBySession(context.tenantId, context.sessionId, context.userId);
        const visibleArtifacts =
          scopedArtifactIds && scopedArtifactIds.length
            ? artifacts.filter((a) => scopedArtifactIds.includes(a.artifactId))
            : artifacts;

        return {
          artifacts: visibleArtifacts.map((a) => ({
            artifactId: a.artifactId,
            artifactType: a.artifactType,
            artifactName: a.artifactName,
            mimeType: a.mimeType,
            status: a.status,
            sourceArtifactId: a.sourceArtifactId,
            createdAt: a.createdAt
          }))
        };
      }
    },

    {
      ...SESSION_TOOL_CATALOG[2], // read_text_artifact
      outputSchema: allRequiredObjectSchema({
        artifact: allRequiredObjectSchema({
          artifactId: { type: "string" },
          artifactName: { type: "string" },
          mimeType: { type: "string" },
          status: { type: "string" }
        }),
        content: { type: "string" },
        truncated: { type: "boolean" }
      }),
      handler: async ({ context, arguments: args }) => {
        const artifactId = String(args.artifactId ?? "");
        if (!artifactId) throw new ToolCallError("artifactId is required.");

        const artifact = await resolveReadableArtifact({ artifacts: deps.artifacts, context, artifactId });
        const maxChars = Math.max(1, Math.min(20_000, Number(args.maxChars ?? 4_000) || 4_000));
        const handle = await deps.storage.openReadStream(artifact.storageKey);
        const bounded = await readStreamAsBoundedText(handle.stream, maxChars);
        const current = await resolveReadableArtifact({ artifacts: deps.artifacts, context, artifactId });
        if (current.artifactId !== artifact.artifactId || current.storageKey !== artifact.storageKey ||
            current.checksumSha256 !== artifact.checksumSha256) {
          throw new ToolCallError("Artifact changed while reading. Retry the read.");
        }

        return {
          artifact: {
            artifactId: artifact.artifactId,
            artifactName: artifact.artifactName,
            mimeType: artifact.mimeType,
            status: artifact.status
          },
          content: bounded.text,
          truncated: bounded.truncated
        };
      }
    }
  ];
}
