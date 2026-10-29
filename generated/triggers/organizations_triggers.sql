-- ============================================
-- AccessNexus: Auto-generated triggers
-- Table: organizations
-- ============================================

CREATE OR REPLACE FUNCTION accessnexus_organizations_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_organizations_updated_at ON organizations;
CREATE TRIGGER accessnexus_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_organizations_updated_at_fn();

CREATE OR REPLACE FUNCTION accessnexus_organizations_audit_log_fn()
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

DROP TRIGGER IF EXISTS accessnexus_organizations_audit_log ON organizations;
CREATE TRIGGER accessnexus_organizations_audit_log
  AFTER INSERT OR UPDATE OR DELETE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_organizations_audit_log_fn();

CREATE OR REPLACE FUNCTION accessnexus_organizations_add_owner_as_admin_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.org_members (org_id, user_id, role) VALUES (NEW.id, NEW.owner_id, 'admin');
          RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_organizations_add_owner_as_admin ON organizations;
CREATE TRIGGER accessnexus_organizations_add_owner_as_admin
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_organizations_add_owner_as_admin_fn();

CREATE OR REPLACE FUNCTION accessnexus_organizations_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
    RAISE EXCEPTION 'organizations: owner_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS accessnexus_organizations_lock_columns ON organizations;
CREATE TRIGGER accessnexus_organizations_lock_columns
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_organizations_lock_columns_fn();
