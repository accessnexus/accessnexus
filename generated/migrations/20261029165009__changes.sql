-- ============================================
-- AccessNexus: Incremental schema changes
-- ============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_log'
      AND column_name = 'created_at'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_log'
      AND column_name = 'changed_at'
  ) THEN
    ALTER TABLE audit_log RENAME COLUMN created_at TO changed_at;
  END IF;
END $$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_log'
      AND column_name = 'record_id'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_log'
      AND column_name = 'operation'
  ) THEN
    ALTER TABLE audit_log RENAME COLUMN record_id TO operation;
  END IF;
END $$;
-- Destructive: column audit_log.action will be dropped.
ALTER TABLE audit_log DROP COLUMN IF EXISTS action;
-- Destructive: column audit_log.user_id will be dropped.
ALTER TABLE audit_log DROP COLUMN IF EXISTS user_id;
-- Destructive: column audit_log.ip_address will be dropped.
ALTER TABLE audit_log DROP COLUMN IF EXISTS ip_address;
