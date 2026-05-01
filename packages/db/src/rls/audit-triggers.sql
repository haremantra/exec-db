-- ============================================================================
-- Audit triggers: every row touched in `comp.*` writes to audit.access_log.
-- Belt-and-suspenders alongside the app-side recordAccess() call.
-- ============================================================================

CREATE OR REPLACE FUNCTION audit.log_comp_access() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_user text := COALESCE(NULLIF(current_setting('app.user_id', true), ''), 'system');
  v_tier text := COALESCE(NULLIF(current_setting('app.tier', true), ''), 'system');
BEGIN
  INSERT INTO audit.access_log (user_id, tier, action, schema_name, table_name, row_pk)
  VALUES (
    v_user,
    v_tier,
    TG_OP,
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    COALESCE(NEW.id::text, OLD.id::text)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'comp'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS audit_comp_writes ON comp.%I;
       CREATE TRIGGER audit_comp_writes
         AFTER INSERT OR UPDATE OR DELETE ON comp.%I
         FOR EACH ROW EXECUTE FUNCTION audit.log_comp_access();',
      tbl, tbl
    );
  END LOOP;
END$$;
