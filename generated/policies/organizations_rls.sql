-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: organizations
-- ============================================

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION accessnexus_organizations_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_organizations_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_organizations_belongs_to_1_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_organizations_belongs_to_2_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_organizations_belongs_to_2_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_organizations_belongs_to_2_fn(uuid) TO authenticated;

DROP POLICY IF EXISTS "accessnexus_organizations_select" ON organizations;
CREATE POLICY "accessnexus_organizations_select"
  ON organizations FOR SELECT
  TO authenticated
  USING (
    ((SELECT auth.uid()) = owner_id)
    OR ((SELECT accessnexus_organizations_belongs_to_1_fn(id)))
  );

DROP POLICY IF EXISTS "accessnexus_organizations_insert" ON organizations;
CREATE POLICY "accessnexus_organizations_insert"
  ON organizations FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) IS NOT NULL)
    AND ((SELECT auth.uid()) = owner_id)
  );

DROP POLICY IF EXISTS "accessnexus_organizations_update" ON organizations;
CREATE POLICY "accessnexus_organizations_update"
  ON organizations FOR UPDATE
  TO authenticated
  USING (
    (SELECT accessnexus_organizations_belongs_to_2_fn(id))
  )
  WITH CHECK (
    (SELECT accessnexus_organizations_belongs_to_2_fn(id))
  );

DROP POLICY IF EXISTS "accessnexus_organizations_delete" ON organizations;
CREATE POLICY "accessnexus_organizations_delete"
  ON organizations FOR DELETE
  TO authenticated
  USING (
    (SELECT accessnexus_organizations_belongs_to_2_fn(id))
  );
