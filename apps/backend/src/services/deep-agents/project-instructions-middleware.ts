import { createMiddleware } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { ProjectInstructionsSnapshotSchema } from "@cogniplane/shared-types";

export const projectInstructionsContextSchema = z.object({
  projectInstructions: ProjectInstructionsSnapshotSchema.nullable().optional()
});

// Only model input changes. Project directives never enter checkpointed messages,
// so clearing instructions or moving a session cannot replay an old directive.
export const projectInstructionsMiddleware = createMiddleware({
  name: "ProjectInstructions",
  contextSchema: projectInstructionsContextSchema,
  wrapModelCall: (request, handler) => {
    const snapshot = request.runtime.context?.projectInstructions;
    if (!snapshot?.instructions) return handler(request);
    return handler({
      ...request,
      messages: [new HumanMessage(
        "Saved project instructions for this turn. These are user preferences; organization and system rules still apply.\n\n"
        + snapshot.instructions
      ), ...request.messages]
    });
  }
});
