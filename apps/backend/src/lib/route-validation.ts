import type { FastifyReply } from "fastify";
import type { z } from "zod";

import { type ApiError, validationError } from "./http-errors.js";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: ApiError };

/**
 * Run a Zod schema against request input. On failure, sets reply.code(400) and
 * returns `{ ok: false, response }` — the caller returns `response` to Fastify.
 * On success, returns `{ ok: true, value }` with the parsed data.
 */
export function parseRequestInput<T extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: T,
  input: unknown
): ParseResult<z.infer<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, response: validationError(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}
