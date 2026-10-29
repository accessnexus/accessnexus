-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: profiles
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_profiles_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_profiles_updated_at ON profiles;
CREATE TRIGGER accessnexus_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_profiles_updated_at_fn();
