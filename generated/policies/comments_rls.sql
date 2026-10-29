-- ============================================
-- AccessNexus: Auto-generated RLS policies
-- Table: comments
-- ============================================

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION accessnexus_comments_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_comments_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_comments_belongs_to_1_fn(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION accessnexus_comments_belongs_to_2_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin', 'manager'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_comments_belongs_to_2_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_comments_belongs_to_2_fn(uuid) TO authenticated;

DROP POLICY IF EXISTS "accessnexus_comments_select" ON comments;
CREATE POLICY "accessnexus_comments_select"
  ON comments FOR SELECT
  TO authenticated
  USING (
    (SELECT accessnexus_comments_belongs_to_1_fn(org_id))
  );

DROP POLICY IF EXISTS "accessnexus_comments_insert" ON comments;
CREATE POLICY "accessnexus_comments_insert"
  ON comments FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT accessnexus_comments_belongs_to_1_fn(org_id)))
    AND ((SELECT auth.uid()) = author_id)
  );

DROP POLICY IF EXISTS "accessnexus_comments_update" ON comments;
CREATE POLICY "accessnexus_comments_update"
  ON comments FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = author_id
  )
  WITH CHECK (
    (((SELECT auth.uid()) = author_id)
    AND ((SELECT accessnexus_comments_belongs_to_1_fn(org_id))))
    AND (edited = true)
  );

DROP POLICY IF EXISTS "accessnexus_comments_delete" ON comments;
CREATE POLICY "accessnexus_comments_delete"
  ON comments FOR DELETE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = author_id)
    OR ((SELECT accessnexus_comments_belongs_to_2_fn(org_id)))
  );
