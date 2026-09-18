-- Whole-project deletion is not part of the first-release product surface.
-- Migration 026 created this queue while that feature existed, then the
-- feature was removed. Drop the unused table on databases that saw 026.
DROP TABLE IF EXISTS project_runtime_gc;
