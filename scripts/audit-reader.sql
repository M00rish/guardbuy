-- Run as the database owner once. Initialize an unreturned random password so the
-- Neon Console can reset it. Reset only this role in Neon, then copy its connection
-- string directly into AUDIT_DATABASE_URL in GitHub. Never put the owner URL there.
CREATE ROLE guardbuy_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE neondb TO guardbuy_auditor;
GRANT USAGE ON SCHEMA public TO guardbuy_auditor;
GRANT SELECT ON "AuditEntry" TO guardbuy_auditor;
ALTER ROLE guardbuy_auditor SET default_transaction_read_only = on;
ALTER ROLE guardbuy_auditor SET statement_timeout = '60s';

DO $audit_password_init$
DECLARE
  initial_password text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
BEGIN
  EXECUTE format('ALTER ROLE guardbuy_auditor LOGIN PASSWORD %L', initial_password);
  initial_password := NULL;
EXCEPTION WHEN OTHERS THEN
  -- Do not expose the dynamic statement (which contains a password) in errors.
  RAISE EXCEPTION 'Audit reader password initialization failed' USING ERRCODE = 'P0001';
END
$audit_password_init$;
