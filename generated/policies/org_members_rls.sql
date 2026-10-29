-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: org_members
-- ============================================

ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION accessnexus_org_members_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_1_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_org_members_belongs_to_2_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_2_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_2_fn(uuid) TO authenticated;

DROP POLICY IF EXISTS "accessnexus_org_members_select" ON org_members;
CREATE POLICY "accessnexus_org_members_select"
  ON org_members FOR SELECT
  TO authenticated
  USING (
    ((SELECT accessnexus_org_members_belongs_to_1_fn(org_id)))
    OR ((SELECT auth.uid()) = user_id)
  );

DROP POLICY IF EXISTS "accessnexus_org_members_insert" ON org_members;
CREATE POLICY "accessnexus_org_members_insert"
  ON org_members FOR INSERT
  TO authenticated
  WITH CHECK (
    FALSE
  );

DROP POLICY IF EXISTS "accessnexus_org_members_update" ON org_members;
CREATE POLICY "accessnexus_org_members_update"
  ON org_members FOR UPDATE
  TO authenticated
  USING (
    (SELECT accessnexus_org_members_belongs_to_2_fn(org_id))
  )
  WITH CHECK (
    (SELECT accessnexus_org_members_belongs_to_2_fn(org_id))
  );

DROP POLICY IF EXISTS "accessnexus_org_members_delete" ON org_members;
CREATE POLICY "accessnexus_org_members_delete"
  ON org_members FOR DELETE
  TO authenticated
  USING (
    ((SELECT accessnexus_org_members_belongs_to_2_fn(org_id)))
    OR ((SELECT auth.uid()) = user_id)
  );
