-- ============================================
-- AccessNexus: Incremental schema changes
-- ============================================

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS fk_invitations_org_id;
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_org_id_fkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_invitations_org_id'
      AND conrelid = 'invitations'::regclass
  ) THEN
    ALTER TABLE invitations ADD CONSTRAINT fk_invitations_org_id FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE org_members DROP CONSTRAINT IF EXISTS fk_org_members_org_id;
ALTER TABLE org_members DROP CONSTRAINT IF EXISTS org_members_org_id_fkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_org_members_org_id'
      AND conrelid = 'org_members'::regclass
  ) THEN
    ALTER TABLE org_members ADD CONSTRAINT fk_org_members_org_id FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_id_user_id_1 ON org_members(org_id, user_id);
