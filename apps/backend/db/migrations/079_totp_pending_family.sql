-- The session family that started a pending authenticator enrolment in the
-- user's own settings. Only that family can confirm it, so another session
-- of the account (for example one from a stolen access token) cannot finish
-- an enrolment that the user started. NULL: an enrolment from the sign-in
-- flow, which has its own binding (the flow cookie), and which a signed-in
-- session cannot confirm. Pending rows from before this migration are NULL,
-- so their self-service confirm asks to start again (they end after 15
-- minutes anyway). See LocalMfaService.startTotpEnrollment.
-- migrate.ts reapplies the table GRANTs after every run.
ALTER TABLE user_totp_factors
  ADD COLUMN IF NOT EXISTS pending_family_id text;
