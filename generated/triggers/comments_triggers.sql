-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: comments
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_comments_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_comments_updated_at ON comments;
CREATE TRIGGER accessnexus_comments_updated_at
  BEFORE UPDATE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_comments_updated_at_fn();

CREATE OR REPLACE FUNCTION accessnexus_comments_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.task_id IS DISTINCT FROM OLD.task_id) THEN
    RAISE EXCEPTION 'comments: org_id, task_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_comments_lock_columns ON comments;
CREATE TRIGGER accessnexus_comments_lock_columns
  BEFORE UPDATE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_comments_lock_columns_fn();

CREATE OR REPLACE FUNCTION accessnexus_comments_same_org_task_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.org_id = NEW.org_id) THEN
            RAISE EXCEPTION 'task % does not belong to org %', NEW.task_id, NEW.org_id USING ERRCODE = '23503';
          END IF;
          RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_comments_same_org_task ON comments;
CREATE TRIGGER accessnexus_comments_same_org_task
  BEFORE INSERT ON comments
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_comments_same_org_task_fn();

CREATE OR REPLACE FUNCTION accessnexus_comments_soft_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.comments SET deleted_at = NOW() WHERE id = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_comments_soft_delete ON comments;
CREATE TRIGGER accessnexus_comments_soft_delete
  BEFORE DELETE ON comments
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_comments_soft_delete_fn();

CREATE OR REPLACE FUNCTION accessnexus_comments_soft_delete_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'comments.deleted_at can only be set by DELETE (soft delete)'
      USING ERRCODE = '42501',
      HINT = 'Delete the row instead; the DELETE policy decides who may. Restore rows with the service role or a security definer RPC.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_comments_soft_delete_guard ON comments;
CREATE TRIGGER accessnexus_comments_soft_delete_guard
  BEFORE UPDATE OF deleted_at ON comments
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_comments_soft_delete_guard_fn();
