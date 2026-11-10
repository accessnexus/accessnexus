-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: org_members
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_org_members_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION '%', 'org_members.' || 'org_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:org_members.' || 'org_id';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION '%', 'org_members.' || 'user_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:org_members.' || 'user_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_org_members_lock_columns ON org_members;
CREATE TRIGGER accessnexus_org_members_lock_columns
  BEFORE UPDATE ON org_members
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_org_members_lock_columns_fn();
