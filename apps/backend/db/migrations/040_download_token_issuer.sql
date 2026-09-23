-- The admin who minted a download token for another user's personal artifact.
-- The token user stays the artifact owner, so the session check is unchanged,
-- but the download gate checks the issuer's current admin membership and the
-- audit event names the issuer. NULL for a token the user minted for itself.
ALTER TABLE artifact_download_tokens ADD COLUMN IF NOT EXISTS issued_by_user_id text;
