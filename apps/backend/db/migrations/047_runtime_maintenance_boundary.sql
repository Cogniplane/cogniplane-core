-- Older databases can still grant schema creation to PUBLIC. Runtime roles
-- need only USAGE. Schema creation remains with the migration owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
