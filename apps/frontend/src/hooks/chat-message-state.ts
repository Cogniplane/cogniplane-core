import type { Message, ToolResult } from "@cogniplane/shared-types";
import { uuidv7 } from "../lib/uuid";

export function buildOptimisticMessage(input: {
  sessionId: string;
  role: Message["role"];
  status: Message["status"];
  content: string;
}): Message {
  const timestamp = new Date().toISOString();
  return {
    messageId: uuidv7(),
    sessionId: input.sessionId,
    role: input.role,
    status: input.status,
    content: input.content,
    reasoningContent: "",
    planContent: "",
    toolResults: [],
    tokenUsage: null,
    modelName: null,
    costUsd: null,
    feedbackRating: null,
    piiScanRunId: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function upsertToolResult(
  toolResults: ToolResult[],
  nextToolResult: ToolResult
): ToolResult[] {
  const index = toolResults.findIndex(
    (toolResult) => toolResult.toolResultId === nextToolResult.toolResultId
  );
  if (index === -1) {
    return [...toolResults, nextToolResult];
  }

  return toolResults.map((toolResult, entryIndex) =>
    entryIndex === index ? nextToolResult : toolResult
  );
}

export function updateMessageById(
  messages: Message[],
  messageId: string,
  recipe: (message: Message) => Message
): Message[] {
  return messages.map((message) => (message.messageId === messageId ? recipe(message) : message));
}

export function patchMessage(
  messages: Message[],
  messageId: string,
  patch: Partial<Message>
): Message[] {
  return updateMessageById(messages, messageId, (message) => ({
    ...message,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  }));
}

export function patchToolResultOutput(
  messages: Message[],
  messageId: string,
  toolResultId: string,
  delta: string
): Message[] {
  return updateMessageById(messages, messageId, (message) => ({
    ...message,
    toolResults: message.toolResults.map((toolResult) =>
      toolResult.toolResultId === toolResultId
        ? {
            ...toolResult,
            output: `${toolResult.output}${delta}`
          }
        : toolResult
    ),
    updatedAt: new Date().toISOString()
  }));
}
