import "fastify";
import type { Redis } from "ioredis";

import type { loadConfig } from "./config.js";
import type { createDatabase } from "./lib/db.js";

declare module "fastify" {
  interface FastifyInstance {
    config: ReturnType<typeof loadConfig>;
    db: ReturnType<typeof createDatabase>;
    redis: Redis | null;
  }

  interface FastifyRequest {
    auth: {
      userId: string;
      tenantId: string;
      isAdmin: boolean;
      role: "owner" | "admin" | "member";
      email?: string;
    };
  }
}
