// Re-export primitives — kept in primitives.ts so schema files can import
// them directly without forcing a circular re-entry through this barrel.
export * from "./primitives.js";

// Re-export zod itself so consumers (notably the frontend, which doesn't
// list zod as a direct dependency) can write `parseResponse(SomeSchema, ...)`
// and rely on the same zod major version the schemas were authored against.
export { z, type ZodType, type ZodSchema } from "zod";

// Schema barrels — runtime-validated API contracts shared with the backend.
// Frontend imports the inferred types; backend imports the schemas (for
// `serialize(...)`) and types both.
export * from "./schemas/admin-runtime.js";
export * from "./schemas/admin-session.js";
export * from "./schemas/admin-user.js";
export * from "./schemas/artifact.js";
export * from "./schemas/integration.js";
export * from "./schemas/mcp-server.js";
export * from "./schemas/message.js";
export * from "./schemas/pii.js";
export * from "./schemas/session.js";
export * from "./schemas/settings.js";
export * from "./schemas/skill.js";
export * from "./schemas/streaming.js";
export * from "./schemas/tenant.js";
