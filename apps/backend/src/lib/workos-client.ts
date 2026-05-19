import { WorkOS } from "@workos-inc/node";

import type { AppConfig } from "../config.js";

let instance: WorkOS | null = null;

export function getWorkOS(config: AppConfig): WorkOS {
  if (!instance) {
    if (!config.WORKOS_API_KEY) {
      throw new Error("WORKOS_API_KEY is required when AUTH_MODE=workos");
    }
    instance = new WorkOS(config.WORKOS_API_KEY);
  }
  return instance;
}
