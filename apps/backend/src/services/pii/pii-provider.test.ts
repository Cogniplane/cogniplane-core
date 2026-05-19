import { test, expect } from "vitest";

import type {
  PiiArtifactScanResult,
  PiiDetectionResult,
  PiiProvider,
  PiiTransformResult
} from "./pii-provider.js";

function buildStubProvider(overrides: Partial<PiiProvider> = {}): PiiProvider {
  return {
    type: "stub",
    detectText: async (): Promise<PiiDetectionResult> => ({
      findings: [],
      providerType: "stub",
      providerModel: null
    }),
    transformText: async ({ text }): Promise<PiiTransformResult> => ({
      transformedText: text,
      findings: [],
      providerType: "stub",
      providerModel: null
    }),
    scanArtifact: async (): Promise<PiiArtifactScanResult> => ({
      findings: [],
      summaryText: null,
      providerType: "stub",
      providerModel: null
    }),
    ...overrides
  };
}

test("PiiProvider stub satisfies the interface with detect/transform/scan methods", async () => {
  const provider = buildStubProvider();

  const detect = await provider.detectText({ text: "hi", entityTypes: ["email"] });
  expect(detect.findings).toEqual([]);
  expect(detect.providerType).toBe("stub");

  const transform = await provider.transformText({ text: "hi", entityTypes: ["email"] });
  expect(transform.transformedText).toBe("hi");

  const scan = await provider.scanArtifact({
    artifactId: "art_1",
    contentType: "text/plain",
    readContent: async () => "hello",
    entityTypes: ["email"]
  });
  expect(scan.findings).toEqual([]);
});

test("PiiProvider implementations can surface findings with position metadata", async () => {
  const provider = buildStubProvider({
    detectText: async ({ text }) => ({
      findings: [
        {
          entityType: "email",
          value: "a@b.co",
          start: text.indexOf("a@b.co"),
          end: text.indexOf("a@b.co") + "a@b.co".length,
          confidence: "high"
        }
      ],
      providerType: "stub",
      providerModel: "test-model"
    })
  });

  const result = await provider.detectText({
    text: "email me at a@b.co please",
    entityTypes: ["email"]
  });
  expect(result.findings.length).toBe(1);
  expect(result.findings[0]?.entityType).toBe("email");
  expect(result.providerModel).toBe("test-model");
});
