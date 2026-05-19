import { z } from "zod";

/**
 * Schema for ISO-8601 timestamp fields in API responses.
 *
 * Backend route handlers often spread `pg` query rows into responses without
 * an explicit mapper step. The `pg` driver parses `TIMESTAMPTZ` columns into
 * native `Date` objects, so the response payload contains a `Date` at the
 * timestamp slot — but Fastify only stringifies it to ISO during JSON
 * serialization, AFTER our `serialize(...)` helper has already validated.
 *
 * If we typed every timestamp as `z.string()`, every such handler would 500
 * for real database-backed requests (and pass tests that fake the row with
 * pre-stringified values — exactly the contract drift R4 was meant to catch
 * but in the opposite direction).
 *
 * `IsoDateSchema` accepts either an already-stringified ISO timestamp OR a
 * native `Date`, and emits the ISO string. Use this for any field documented
 * as a timestamp; keep `z.string()` for opaque string fields (IDs, hashes,
 * names, tokens, …).
 */
export const IsoDateSchema = z.union([
  z.string(),
  z.date().transform((d) => d.toISOString())
]);
