-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: org_members
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_org_members_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'org_members: org_id, user_id cannot be changed'
      USING ERRCODE = '42501';
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
