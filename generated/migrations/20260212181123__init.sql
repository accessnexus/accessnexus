-- ============================================
-- AccessNexus: Auto-generated migrations
-- Generated at: 2026-02-12T18:11:23.943Z
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organizations_plan_enum') THEN
    CREATE TYPE organizations_plan_enum AS ENUM ('free', 'pro', 'enterprise');
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_members_role_enum') THEN
    CREATE TYPE org_members_role_enum AS ENUM ('admin', 'manager', 'member', 'viewer');
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'projects_status_enum') THEN
    CREATE TYPE projects_status_enum AS ENUM ('active', 'archived', 'completed');
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tasks_status_enum') THEN
    CREATE TYPE tasks_status_enum AS ENUM ('todo', 'in_progress', 'review', 'done');
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tasks_priority_enum') THEN
    CREATE TYPE tasks_priority_enum AS ENUM ('low', 'medium', 'high', 'critical');
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_log_action_enum') THEN
    CREATE TYPE audit_log_action_enum AS ENUM ('INSERT', 'UPDATE', 'DELETE');
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invitations_role_enum') THEN
    CREATE TYPE invitations_role_enum AS ENUM ('manager', 'member', 'viewer');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS profiles (
  id UUID DEFAULT gen_random_uuid() REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_profiles_id_fk ON profiles(id);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL REFERENCES profiles(id),
  logo_url TEXT,
  plan organizations_plan_enum NOT NULL,
  settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_organizations_owner_id_fk ON organizations(owner_id);

CREATE TABLE IF NOT EXISTS org_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  role org_members_role_enum NOT NULL,
  invited_by UUID REFERENCES profiles(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_members_org_id_fk ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id_fk ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_invited_by_fk ON org_members(invited_by);

CREATE TABLE IF NOT EXISTS projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  status projects_status_enum NOT NULL,
  created_by UUID NOT NULL REFERENCES profiles(id),
  is_public BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_projects_org_id_fk ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_created_by_fk ON projects(created_by);
CREATE INDEX IF NOT EXISTS idx_projects_active_pk ON projects(id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT,
  status tasks_status_enum NOT NULL,
  priority tasks_priority_enum NOT NULL,
  assignee_id UUID REFERENCES profiles(id),
  reporter_id UUID NOT NULL REFERENCES profiles(id),
  due_date DATE,
  estimated_hours DOUBLE PRECISION,
  tags TEXT[],
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_org_id_fk ON tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id_fk ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id_fk ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reporter_id_fk ON tasks(reporter_id);

CREATE TABLE IF NOT EXISTS comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  task_id UUID NOT NULL REFERENCES tasks(id),
  author_id UUID NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL,
  edited BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comments_org_id_fk ON comments(org_id);
CREATE INDEX IF NOT EXISTS idx_comments_task_id_fk ON comments(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_author_id_fk ON comments(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_active_pk ON comments(id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action audit_log_action_enum NOT NULL,
  old_data JSONB,
  new_data JSONB,
  user_id UUID,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invitations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role invitations_role_enum NOT NULL,
  invited_by UUID NOT NULL REFERENCES profiles(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invitations_org_id_fk ON invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_invitations_invited_by_fk ON invitations(invited_by);
