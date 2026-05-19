import { z } from "zod";

/**
 * Shared Zod schemas for common route parameter patterns.
 * Avoids repeating `z.object({ sessionId: z.string().uuid() })` across files.
 */

export const sessionIdParams = z.object({ sessionId: z.string().uuid() });
export const artifactIdParams = z.object({ artifactId: z.string().uuid() });
export const messageIdParams = z.object({ messageId: z.string().uuid() });
export const jobIdParams = z.object({ jobId: z.string().uuid() });
