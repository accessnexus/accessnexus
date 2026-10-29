-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: audit_log
-- ============================================

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accessnexus_audit_log_select" ON audit_log;
CREATE POLICY "accessnexus_audit_log_select"
  ON audit_log FOR SELECT
  TO authenticated
  USING (
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin'
  );

DROP POLICY IF EXISTS "accessnexus_audit_log_insert" ON audit_log;
CREATE POLICY "accessnexus_audit_log_insert"
  ON audit_log FOR INSERT
  TO authenticated
  WITH CHECK (
    FALSE
  );

DROP POLICY IF EXISTS "accessnexus_audit_log_update" ON audit_log;
CREATE POLICY "accessnexus_audit_log_update"
  ON audit_log FOR UPDATE
  TO authenticated
  USING (
    FALSE
  )
  WITH CHECK (
    FALSE
  );

DROP POLICY IF EXISTS "accessnexus_audit_log_delete" ON audit_log;
CREATE POLICY "accessnexus_audit_log_delete"
  ON audit_log FOR DELETE
  TO authenticated
  USING (
    FALSE
  );
