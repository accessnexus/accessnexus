-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: tasks
-- ============================================

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION accessnexus_tasks_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_tasks_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_tasks_belongs_to_1_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_tasks_belongs_to_2_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin', 'manager', 'member'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_tasks_belongs_to_2_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_tasks_belongs_to_2_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_tasks_belongs_to_3_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin', 'manager'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_tasks_belongs_to_3_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_tasks_belongs_to_3_fn(uuid) TO authenticated;

DROP POLICY IF EXISTS "accessnexus_tasks_select" ON tasks;
CREATE POLICY "accessnexus_tasks_select"
  ON tasks FOR SELECT
  TO authenticated
  USING (
    (SELECT accessnexus_tasks_belongs_to_1_fn(org_id))
  );

DROP POLICY IF EXISTS "accessnexus_tasks_insert" ON tasks;
CREATE POLICY "accessnexus_tasks_insert"
  ON tasks FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT accessnexus_tasks_belongs_to_2_fn(org_id)))
    AND ((SELECT auth.uid()) = reporter_id)
  );

DROP POLICY IF EXISTS "accessnexus_tasks_update" ON tasks;
CREATE POLICY "accessnexus_tasks_update"
  ON tasks FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = assignee_id)
    OR ((SELECT accessnexus_tasks_belongs_to_3_fn(org_id)))
  )
  WITH CHECK (
    (((SELECT auth.uid()) = assignee_id)
    OR ((SELECT accessnexus_tasks_belongs_to_3_fn(org_id))))
    AND ((SELECT accessnexus_tasks_belongs_to_1_fn(org_id)))
  );

DROP POLICY IF EXISTS "accessnexus_tasks_delete" ON tasks;
CREATE POLICY "accessnexus_tasks_delete"
  ON tasks FOR DELETE
  TO authenticated
  USING (
    (SELECT accessnexus_tasks_belongs_to_3_fn(org_id))
  );
