-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: projects
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_projects_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_projects_updated_at ON projects;
CREATE TRIGGER accessnexus_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_projects_updated_at_fn();

CREATE OR REPLACE FUNCTION accessnexus_projects_audit_log_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE JSONB_BUILD_OBJECT('name', OLD.name, 'status', OLD.status) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE JSONB_BUILD_OBJECT('name', NEW.name, 'status', NEW.status) END,
    NOW()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_projects_audit_log ON projects;
CREATE TRIGGER accessnexus_projects_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_projects_audit_log_fn();

CREATE OR REPLACE FUNCTION accessnexus_projects_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    RAISE EXCEPTION 'projects: created_by, org_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_projects_lock_columns ON projects;
CREATE TRIGGER accessnexus_projects_lock_columns
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_projects_lock_columns_fn();

CREATE OR REPLACE FUNCTION accessnexus_projects_soft_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.projects SET deleted_at = NOW() WHERE id = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_projects_soft_delete ON projects;
CREATE TRIGGER accessnexus_projects_soft_delete
  BEFORE DELETE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_projects_soft_delete_fn();

CREATE OR REPLACE FUNCTION accessnexus_projects_soft_delete_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'projects.deleted_at can only be set by DELETE (soft delete)'
      USING ERRCODE = '42501',
      HINT = 'Delete the row instead; the DELETE policy decides who may. Restore rows with the service role or a security definer RPC.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_projects_soft_delete_guard ON projects;
CREATE TRIGGER accessnexus_projects_soft_delete_guard
  BEFORE UPDATE OF deleted_at ON projects
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_projects_soft_delete_guard_fn();
