-- ============================================
-- AccessNexus: Incremental schema changes
-- ============================================

ALTER INDEX IF EXISTS idx_org_members_org_id_user_id_1 RENAME TO idx_org_members_org_id_user_id_uniq;
DROP INDEX IF EXISTS idx_org_members_org_id_fk;
