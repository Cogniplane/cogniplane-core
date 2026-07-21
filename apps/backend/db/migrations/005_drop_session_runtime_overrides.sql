-- Drop the dead session_runtime_overrides table (code-review R12).
--
-- The per-session runtime override was written only by the skill-improvement
-- session flow, which was removed in the runtime collapse (Codex/Claude-Code
-- retirement). Since then nothing writes the table and the config compiler's
-- read path always resolved to null, so the override merge was inert. The
-- backend store, read path, and compiler merge logic are removed in the same
-- change; this migration drops the now-orphaned table.
--
-- CASCADE also removes the FK constraints, primary key, and RLS policy defined
-- alongside the table in 001_init.sql. IF EXISTS keeps this safe to re-apply.

DROP TABLE IF EXISTS public.session_runtime_overrides CASCADE;
