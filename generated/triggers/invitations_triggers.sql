-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: invitations
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_invitations_set_expiry_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.expires_at IS NULL THEN
            NEW.expires_at = NOW() + interval '7 days';
          END IF;
          RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_invitations_set_expiry ON invitations;
CREATE TRIGGER accessnexus_invitations_set_expiry
  BEFORE INSERT ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_invitations_set_expiry_fn();
