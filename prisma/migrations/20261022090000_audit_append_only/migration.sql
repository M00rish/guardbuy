-- The audit log is append-only in the database itself.
--
-- Layer 1 (this trigger): any UPDATE, DELETE or TRUNCATE of "AuditEntry" is rejected, whoever runs it,
-- unless the transaction first opts in with
--   SET LOCAL guardbuy.audit_rewrite = 'on';
-- Only check scripts cleaning up throwaway test shops (and, later, privacy deletions) do that, through
-- the owner connection. A stray edit from a console or a bug fails loudly instead of rewriting history.
--
-- Layer 2 (scripts/create-app-role.ts): the deployed app connects as "guardbuy_app", which has no
-- UPDATE, DELETE or TRUNCATE privilege on "AuditEntry" at all, so it can't opt in either.

CREATE OR REPLACE FUNCTION guardbuy_audit_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('guardbuy.audit_rewrite', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'AuditEntry is append-only: % is not allowed', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RETURN NULL;
  ELSIF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEntry_append_only_rows"
  BEFORE UPDATE OR DELETE ON "AuditEntry"
  FOR EACH ROW EXECUTE FUNCTION guardbuy_audit_append_only();

CREATE TRIGGER "AuditEntry_append_only_truncate"
  BEFORE TRUNCATE ON "AuditEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION guardbuy_audit_append_only();
