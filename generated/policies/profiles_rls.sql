-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: profiles
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accessnexus_profiles_select" ON profiles;
CREATE POLICY "accessnexus_profiles_select"
  ON profiles FOR SELECT
  TO public
  USING (
    ((SELECT auth.uid()) = id)
    OR (id IN (SELECT m.user_id FROM org_members m WHERE m.org_id IN (SELECT my.org_id FROM org_members my WHERE my.user_id = (SELECT auth.uid()))))
  );

DROP POLICY IF EXISTS "accessnexus_profiles_insert" ON profiles;
CREATE POLICY "accessnexus_profiles_insert"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = id
  );

DROP POLICY IF EXISTS "accessnexus_profiles_update" ON profiles;
CREATE POLICY "accessnexus_profiles_update"
  ON profiles FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = id
  )
  WITH CHECK (
    (SELECT auth.uid()) = id
  );

DROP POLICY IF EXISTS "accessnexus_profiles_delete" ON profiles;
CREATE POLICY "accessnexus_profiles_delete"
  ON profiles FOR DELETE
  TO authenticated
  USING (
    FALSE
  );
