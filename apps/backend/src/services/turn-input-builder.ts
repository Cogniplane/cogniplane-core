import type { RuntimeUserInput } from "../runtime-contracts.js";

import { isTextReadableArtifact, readArtifactExcerpt } from "./artifacts/artifact-helpers.js";

const MAX_ARTIFACT_BUDGET_CHARS = 18_000;
const PER_ARTIFACT_EXCERPT_CHARS = 6_000;
import type { ArtifactStorage } from "./artifacts/artifact-storage.js";
import type { ArtifactProcessor } from "./artifacts/artifact-processor.js";
import type { ArtifactRecord } from "./artifacts/artifact-store.js";
import type { SyncedArtifact } from "./artifacts/artifact-workspace-sync.js";

export type ArtifactTurnInput = {
  prompt: string;
  scopedArtifacts: ArtifactRecord[];
  artifactProcessor: ArtifactProcessor;
  storage: ArtifactStorage;
  syncedArtifacts?: SyncedArtifact[];
};

export type PreparedTurnInputs = {
  userInputs?: RuntimeUserInput[];
  cleanup: Array<() => Promise<void>>;
};

export async function buildArtifactTurnInputs(
  input: ArtifactTurnInput
): Promise<PreparedTurnInputs> {
  const { prompt, scopedArtifacts, syncedArtifacts } = input;
  if (!scopedArtifacts.length) {
    return {
      userInputs: undefined,
      cleanup: []
    };
  }

  const syncedMap = new Map<string, SyncedArtifact>();
  if (syncedArtifacts) {
    for (const sa of syncedArtifacts) {
      if (sa.synced) {
        syncedMap.set(sa.artifact.artifactId, sa);
      }
    }
  }

  const hasSyncedFiles = syncedMap.size > 0;

  const syncedList: Array<{ artifact: ArtifactRecord; workspacePath: string }> = [];
  const fallbackList: ArtifactRecord[] = [];

  for (const artifact of scopedArtifacts) {
    const synced = syncedMap.get(artifact.artifactId);
    if (synced) {
      syncedList.push({ artifact, workspacePath: synced.workspacePath });
    } else {
      fallbackList.push(artifact);
    }
  }

  const syncedLines: string[] = [];
  if (syncedList.length) {
    for (const { artifact, workspacePath } of syncedList) {
      syncedLines.push(`  - ${workspacePath} (${artifact.artifactId}; ${artifact.mimeType}; ${artifact.artifactType})`);
    }
  }

  const inlineArtifactBlocks: string[] = [];
  const imageInputs: RuntimeUserInput[] = [];
  const attachmentNotes: string[] = [];
  const cleanup: Array<() => Promise<void>> = [];
  let remainingBudget = MAX_ARTIFACT_BUDGET_CHARS;

  for (const artifact of fallbackList) {
    const excerptBudget = Math.min(remainingBudget, PER_ARTIFACT_EXCERPT_CHARS);

    if (isTextReadableArtifact(artifact.mimeType) && remainingBudget > 0) {
      const content = await readArtifactExcerpt(input.storage, artifact.storageKey, excerptBudget);
      if (content.trim()) {
        remainingBudget -= content.length;
        inlineArtifactBlocks.push(
          [
            `Artifact content: ${artifact.artifactName}`,
            `- Source artifact id: ${artifact.artifactId}`,
            `- Readable artifact: ${artifact.artifactName} (${artifact.mimeType})`,
            "```text",
            content,
            "```"
          ].join("\n")
        );
      }
      continue;
    }

    if (artifact.mimeType !== "application/pdf") {
      continue;
    }

    const [extractedTextResult, renderedImages] = await Promise.all([
      remainingBudget > 0
        ? input.artifactProcessor
            .extractArtifactText(artifact)
            .then((content) => content?.slice(0, excerptBudget) ?? "")
            .catch(() => "")
        : Promise.resolve(""),
      input.artifactProcessor.renderArtifactImages(artifact).catch(() => ({
        paths: [],
        cleanup: async () => {}
      }))
    ]);

    if (extractedTextResult.trim()) {
      remainingBudget -= extractedTextResult.length;
      inlineArtifactBlocks.push(
        [
          `Artifact content: ${artifact.artifactName}`,
          `- Source artifact id: ${artifact.artifactId}`,
          `- Extracted on demand from PDF: ${artifact.artifactName} (${artifact.mimeType})`,
          "```text",
          extractedTextResult,
          "```"
        ].join("\n")
      );
    }

    if (renderedImages.paths.length) {
      attachmentNotes.push(
        `- Attached ${renderedImages.paths.length} rendered PDF page image(s) from: ${artifact.artifactName}`
      );
      cleanup.push(renderedImages.cleanup);
      imageInputs.push(
        ...renderedImages.paths.map((imagePath) => ({
          type: "localImage" as const,
          path: imagePath
        }))
      );
    }
  }

  const promptLines: (string | null)[] = ["Artifact context:"];

  if (hasSyncedFiles) {
    promptLines.push(
      "- Session artifacts have been synced to the workspace under `./artifacts/`.",
      "- Read them directly using your native file reading capabilities.",
      `- Synced artifacts (${syncedList.length}):`,
      ...syncedLines
    );
  }

  if (fallbackList.length) {
    if (hasSyncedFiles) {
      promptLines.push(
        `- The following ${fallbackList.length} artifact(s) could not be synced to the workspace:`,
      );
    }
    const fallbackListLines = fallbackList.slice(0, 20).map((artifact) =>
      `  - ${artifact.artifactName} (${artifact.artifactId}; ${artifact.mimeType}; ${artifact.artifactType})`
    );
    promptLines.push(...fallbackListLines);

    if (!hasSyncedFiles) {
      promptLines.push(
        "- Uploaded session artifacts are not stored in the runtime workspace.",
        "- Do not use shell commands or workspace file search to locate uploaded artifacts.",
        inlineArtifactBlocks.length || imageInputs.length
          ? "- Use the embedded artifact text blocks and attached local images as the primary source material for this turn."
          : "- Answer only from the visible artifact metadata if no readable text or rendered pages are attached in this turn.",
      );
    }

    promptLines.push(...attachmentNotes);
    if (inlineArtifactBlocks.length) {
      promptLines.push("");
      promptLines.push(...inlineArtifactBlocks);
    }
  }

  promptLines.push("", prompt);

  const promptText = promptLines
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    userInputs: [
      {
        type: "text",
        text: promptText
      },
      ...imageInputs
    ],
    cleanup
  };
}
