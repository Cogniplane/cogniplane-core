-- Single-use artifact download tokens.
--
-- Adds `consumed_at` to artifact_download_tokens so a leaked token (browser
-- history, chat paste, screen-share) cannot be replayed for the full TTL.
-- The download route flips this column with `UPDATE ... WHERE consumed_at
-- IS NULL RETURNING ...` so the first call wins and subsequent calls miss.

ALTER TABLE public.artifact_download_tokens
  ADD COLUMN consumed_at timestamp with time zone;
