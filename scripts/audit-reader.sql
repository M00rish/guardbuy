-- Run as the database owner once. Set the LOGIN password separately through a secure
-- administrative connection; never commit it or place the owner URL in Actions.
CREATE ROLE guardbuy_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO guardbuy_auditor;
GRANT SELECT ON "AuditEntry" TO guardbuy_auditor;
ALTER ROLE guardbuy_auditor SET default_transaction_read_only = on;
ALTER ROLE guardbuy_auditor SET statement_timeout = '60s';
