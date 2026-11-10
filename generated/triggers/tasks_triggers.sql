-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: tasks
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_tasks_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_tasks_updated_at ON tasks;
CREATE TRIGGER accessnexus_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_tasks_updated_at_fn();

CREATE OR REPLACE FUNCTION accessnexus_tasks_audit_log_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    NOW()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_tasks_audit_log ON tasks;
CREATE TRIGGER accessnexus_tasks_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_tasks_audit_log_fn();

CREATE OR REPLACE FUNCTION accessnexus_tasks_lock_identity_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.reporter_id IS DISTINCT FROM OLD.reporter_id THEN
      RAISE EXCEPTION '%', 'tasks.' || 'reporter_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || 'reporter_id';
    END IF;
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION '%', 'tasks.' || 'org_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || 'org_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_tasks_lock_identity ON tasks;
CREATE TRIGGER accessnexus_tasks_lock_identity
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_tasks_lock_identity_fn();

CREATE OR REPLACE FUNCTION accessnexus_tasks_assignee_scope_fn()
RETURNS TRIGGER AS $$
DECLARE
  locked_column text;
BEGIN
  IF current_user IN ('anon', 'authenticated') AND NOT COALESCE((EXISTS (
  SELECT 1 FROM org_members m
  WHERE m.org_id = OLD.org_id AND m.user_id = (SELECT auth.uid()) AND m.role IN ('admin', 'manager')
)), FALSE) THEN
    SELECT n.key INTO locked_column
      FROM jsonb_each(to_jsonb(NEW) - ARRAY['status', 'position', 'updated_at']::text[]) AS n
     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
     ORDER BY n.key LIMIT 1;
    IF locked_column IS NOT NULL THEN
      RAISE EXCEPTION '%', 'tasks.' || locked_column || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || locked_column;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_tasks_assignee_scope ON tasks;
CREATE TRIGGER accessnexus_tasks_assignee_scope
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_tasks_assignee_scope_fn();

CREATE OR REPLACE FUNCTION accessnexus_tasks_same_org_project_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
            RAISE EXCEPTION 'project % does not belong to org %', NEW.project_id, NEW.org_id USING ERRCODE = '23503';
          END IF;
          RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_tasks_same_org_project ON tasks;
CREATE TRIGGER accessnexus_tasks_same_org_project
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_tasks_same_org_project_fn();

CREATE OR REPLACE FUNCTION accessnexus_tasks_validate_status_transition_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'done' AND NEW.status = 'todo' THEN
            RAISE EXCEPTION 'Cannot move a done task back to todo';
          END IF;
          RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_tasks_validate_status_transition ON tasks;
CREATE TRIGGER accessnexus_tasks_validate_status_transition
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION accessnexus_tasks_validate_status_transition_fn();
