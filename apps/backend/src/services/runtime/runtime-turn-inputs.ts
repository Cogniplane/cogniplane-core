import type { RuntimeUserInput } from "../../runtime-contracts.js";

import type { ResolvedRuntimePolicy } from "../admin-config-records.js";

function buildPrompt(input: {
  prompt: string;
  runtimePolicy: ResolvedRuntimePolicy;
  toolContextId: string | null;
}): string {
  if (!input.runtimePolicy.enabledMcpServers.length || !input.toolContextId) {
    return input.prompt;
  }

  return [
    "Framework turn context:",
    `- runtimePolicyId: ${input.runtimePolicy.id}`,
    `- toolContextId: ${input.toolContextId}`,
    "- If you call an MCP tool, pass the exact toolContextId argument unchanged.",
    "",
    input.prompt
  ].join("\n");
}

export function buildTurnInputs(input: {
  prompt: string;
  userInputs?: RuntimeUserInput[];
  runtimePolicy: ResolvedRuntimePolicy;
  toolContextId: string | null;
}): Array<
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
> {
  const baseInputs = input.userInputs?.length
    ? input.userInputs
    : [{ type: "text", text: input.prompt } satisfies RuntimeUserInput];

  return baseInputs.map((entry, index) => {
    if (entry.type === "text") {
      return {
        type: "text" as const,
        text:
          index === 0
            ? buildPrompt({
                prompt: entry.text,
                runtimePolicy: input.runtimePolicy,
                toolContextId: input.toolContextId
              })
            : entry.text,
        text_elements: []
      };
    }

    if (entry.type === "image") {
      return {
        type: "image" as const,
        url: entry.url
      };
    }

    return {
      type: "localImage" as const,
      path: entry.path
    };
  });
}
