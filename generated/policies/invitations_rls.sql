-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: invitations
-- ============================================

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION accessnexus_invitations_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin', 'manager'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_invitations_belongs_to_1_fn(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accessnexus_invitations_belongs_to_1_fn(uuid) TO authenticated, anon;
CREATE OR REPLACE FUNCTION accessnexus_invitations_belongs_to_2_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_invitations_belongs_to_2_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_invitations_belongs_to_2_fn(uuid) TO authenticated;

DROP POLICY IF EXISTS "accessnexus_invitations_select" ON invitations;
CREATE POLICY "accessnexus_invitations_select"
  ON invitations FOR SELECT
  TO public
  USING (
    (email = ((SELECT auth.jwt()) ->> 'email'))
    OR ((SELECT accessnexus_invitations_belongs_to_1_fn(org_id)))
  );

DROP POLICY IF EXISTS "accessnexus_invitations_insert" ON invitations;
CREATE POLICY "accessnexus_invitations_insert"
  ON invitations FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT accessnexus_invitations_belongs_to_1_fn(org_id)))
    AND ((SELECT auth.uid()) = invited_by)
    AND (((SELECT accessnexus_invitations_belongs_to_2_fn(org_id)))
    OR (role IN ('member', 'viewer')))
  );

DROP POLICY IF EXISTS "accessnexus_invitations_update" ON invitations;
CREATE POLICY "accessnexus_invitations_update"
  ON invitations FOR UPDATE
  TO authenticated
  USING (
    FALSE
  )
  WITH CHECK (
    FALSE
  );

DROP POLICY IF EXISTS "accessnexus_invitations_delete" ON invitations;
CREATE POLICY "accessnexus_invitations_delete"
  ON invitations FOR DELETE
  TO authenticated
  USING (
    (SELECT accessnexus_invitations_belongs_to_2_fn(org_id))
  );
