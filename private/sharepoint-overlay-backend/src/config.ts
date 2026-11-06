import { z } from "zod";

const overlayConfigSchema = z.object({
  MICROSOFT_OAUTH_REDIRECT_URI: z.string().url().optional()
});

export type SharepointOverlayConfig = z.infer<typeof overlayConfigSchema>;

export function loadOverlayConfig(env: NodeJS.ProcessEnv = process.env): SharepointOverlayConfig {
  return overlayConfigSchema.parse({
    MICROSOFT_OAUTH_REDIRECT_URI: env.MICROSOFT_OAUTH_REDIRECT_URI || undefined
  });
}
