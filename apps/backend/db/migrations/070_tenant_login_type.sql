-- Login type per tenant, feature 0 of docs/plans/2026-10-25-local-auth.md.
--
-- tenants.login_type: how the members of a tenant sign in. It is set when the
-- tenant is created and never changes (plan section 3.15). Existing tenants
-- were all created by WorkOS sign-in, so the default is 'workos'.
--
-- users.auth_source: which login path owns the user row. Existing rows are
-- WorkOS rows or rows that dev-headers mode and seeds create; 'workos' is
-- correct for all of them, because none of them can sign in another way.
--
-- users.email_key: the email in lowercase without surrounding spaces. Both
-- login paths look up and lock users by this key, so 'Alice@example.com' and
-- 'alice@example.com' are the same person (plan section 3.2).

-- Duration. Adding the generated email_key column rewrites the users table, and
-- the exclusive lock stays until the unique index exists. Sign-in reads users,
-- so sign-in waits while this runs. The migration connection has a 30-second
-- statement timeout (lib/db.ts), which a large users table can pass; then the
-- migration rolls back. This file raises the limit for its own transaction only.
-- The runner's 10-second lock_timeout still applies, so the migration fails
-- fast instead of queueing sign-ins behind a lock it cannot get. On a large
-- users table, run it in a maintenance window and measure on a copy first.
SET LOCAL statement_timeout = '15min';

-- Stop before the unique key fails half-way with a less useful message. The
-- operator resolves duplicates by hand: they can belong to different people.
DO $$
DECLARE
  duplicate_key text;
BEGIN
  SELECT lower(btrim(email)) INTO duplicate_key
  FROM users
  WHERE email IS NOT NULL
  GROUP BY lower(btrim(email))
  HAVING count(*) > 1
  LIMIT 1;
  IF duplicate_key IS NOT NULL THEN
    RAISE EXCEPTION 'users has more than one row for the email %, ignoring case and spaces. Resolve the duplicates, then run the migration again.', duplicate_key;
  END IF;
END;
$$;

ALTER TABLE users
  ADD COLUMN auth_source text NOT NULL DEFAULT 'workos'
    CONSTRAINT users_auth_source_check CHECK (auth_source IN ('workos', 'local')),
  ADD COLUMN email_key text GENERATED ALWAYS AS (lower(btrim(email))) STORED;

ALTER TABLE users ADD CONSTRAINT users_email_key_key UNIQUE (email_key);

ALTER TABLE tenants
  ADD COLUMN login_type text NOT NULL DEFAULT 'workos'
    CONSTRAINT tenants_login_type_check CHECK (login_type IN ('workos', 'local'));

CREATE FUNCTION enforce_tenant_login_type_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.login_type IS DISTINCT FROM OLD.login_type THEN
    RAISE EXCEPTION 'tenants.login_type cannot change after the tenant is created'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_login_type_immutable
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_login_type_immutable();
