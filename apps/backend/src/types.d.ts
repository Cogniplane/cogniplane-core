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
      /**
       * Set for a browser session in jwt mode: the session's refresh family,
       * the login path, and (local accounts) the security version the token
       * carries. Step-up proof binds to them.
       */
      session?: {
        familyId?: string;
        authSource: "workos" | "local";
        securityVersion?: number;
        /** How the session was signed in (the token's amr claim). */
        amr?: import("./lib/jwt.js").AuthMethod[];
      };
    };
  }
}
