-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: projects
-- ============================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION accessnexus_projects_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_projects_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_projects_belongs_to_1_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_projects_belongs_to_2_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin', 'manager'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_projects_belongs_to_2_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_projects_belongs_to_2_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_projects_belongs_to_3_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_projects_belongs_to_3_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_projects_belongs_to_3_fn(uuid) TO authenticated;

DROP POLICY IF EXISTS "accessnexus_projects_select" ON projects;
CREATE POLICY "accessnexus_projects_select"
  ON projects FOR SELECT
  TO authenticated
  USING (
    (SELECT accessnexus_projects_belongs_to_1_fn(org_id))
  );

DROP POLICY IF EXISTS "accessnexus_projects_insert" ON projects;
CREATE POLICY "accessnexus_projects_insert"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT accessnexus_projects_belongs_to_2_fn(org_id)))
    AND ((SELECT auth.uid()) = created_by)
  );

DROP POLICY IF EXISTS "accessnexus_projects_update" ON projects;
CREATE POLICY "accessnexus_projects_update"
  ON projects FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = created_by)
    OR ((SELECT accessnexus_projects_belongs_to_2_fn(org_id)))
  )
  WITH CHECK (
    (((SELECT auth.uid()) = created_by)
    OR ((SELECT accessnexus_projects_belongs_to_2_fn(org_id))))
    AND ((SELECT accessnexus_projects_belongs_to_1_fn(org_id)))
  );

DROP POLICY IF EXISTS "accessnexus_projects_delete" ON projects;
CREATE POLICY "accessnexus_projects_delete"
  ON projects FOR DELETE
  TO authenticated
  USING (
    (SELECT accessnexus_projects_belongs_to_3_fn(org_id))
  );
