import { createMiddleware } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

export const memoryContextSchema = z.object({
  memoryContext: z.string().nullable().optional()
});

// Recalled memories are data that a model or a user wrote. They enter model
// input as a labelled message of their own, never as part of the system prompt.
// Only model input changes: the message is not part of the saved conversation or
// the checkpoint, so an edit or a delete in settings applies on the next call
// and nothing stale is replayed. The system prompt stays the same between turns,
// which keeps its prompt-cache prefix valid.
export const memoryContextMiddleware = createMiddleware({
  name: "SavedMemories",
  contextSchema: memoryContextSchema,
  wrapModelCall: (request, handler) => {
    const memoryContext = request.runtime.context?.memoryContext;
    if (!memoryContext) return handler(request);
    return handler({ ...request, messages: [new HumanMessage(memoryContext), ...request.messages] });
  }
});
