// ============================================
// AccessNexus - Full Example Schema
// Project Management SaaS (multi-tenant)
// Demonstrates ALL features: policies, permissions,
// triggers, RPCs, seed, soft delete, enums, refs
//
// In your project, import from 'accessnexus' instead of '../src/index.js':
//   import { defineSchema, table, policy, ... } from 'accessnexus';
// ============================================

import {
  definePermissions,
  defineSchema,
  policy,
  rpc,
  table,
  trigger,
} from '../src/index.js';

// ============================================
// 1. PERMISSIONS (centralized RBAC)
// ============================================

const permissions = definePermissions({
  // All roles in the system
  roles: ['admin', 'manager', 'member', 'viewer'],

  // Multi-tenant config: users belong to orgs via org_members
  tenant: {
    table: 'org_members',
    userColumn: 'user_id',
    tenantColumn: 'org_id',
    roleColumn: 'role',
  },

  // Per-resource permission rules. Roles here are roles INSIDE an org
  // ({ scope: 'tenant', roles }). A bare array like ['admin'] would mean a
  // global app role from the JWT app_metadata — not what "org admin" means.
  // Writes are pinned by default: create sets ownerColumn = auth.uid(), and
  // create/update keep rows inside an org the user belongs to.
  resources: {
    organizations: {
      ownerColumn: 'owner_id',                         // creator must be the owner
      tenantColumn: 'id',                              // the row IS the tenant
      read: { any: ['own', { scope: 'tenant' }] },     // members (+ creator, for INSERT ... RETURNING);
                                                       // not 'public': it would expose owner_id/settings
      create: '*',                                     // any authenticated user
      update: { scope: 'tenant', roles: ['admin'] },   // org admins only (managers
                                                       // must not touch owner/settings)
      delete: { scope: 'tenant', roles: ['admin'] },
    },
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },                       // any org member
      create: { scope: 'tenant', roles: ['admin', 'manager'] },
      update: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
      delete: { scope: 'tenant', roles: ['admin'] },
    },
    tasks: {
      ownerColumn: 'assignee_id',
      tenantColumn: 'org_id',
      pinOwnerOnCreate: false,                         // managers assign tasks to others
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['admin', 'manager', 'member'] },
      update: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
      delete: { scope: 'tenant', roles: ['admin', 'manager'] },
    },
    comments: {
      ownerColumn: 'author_id',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant' },
      update: 'own',
      delete: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
    },
  },
});

/**
 * The current user is an org admin/manager. Raw SQL for trigger conditions
 * (NEW/OLD are the row); it runs as the caller, so org_members' own RLS applies.
 */
const IS_ORG_ADMIN_OR_MANAGER = `EXISTS (
  SELECT 1 FROM org_members m
  WHERE m.org_id = OLD.org_id AND m.user_id = (SELECT auth.uid()) AND m.role IN ('admin', 'manager')
)`;

/** Current user is a member of the row's org (optionally with one of `roles`). */
function orgMember(roles?: string[]) {
  return policy.belongsTo('org_id', {
    table: 'org_members',
    foreignKey: 'org_id',
    localKey: 'user_id',
    ...(roles ? { where: { role: roles } } : {}),
  });
}

// ============================================
// 2. SCHEMA (tables, policies, triggers, RPCs)
// ============================================

const schema = defineSchema({
  // ---- Users / Profiles ----
  profiles: table({
    columns: {
      id: 'uuid',
      email: { type: 'text', unique: true },
      name: 'text',
      avatar_url: 'text?',
      bio: 'text?',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: {
      id: 'auth.users.id',
    },
    triggers: [
      trigger.updatedAt('updated_at'),
    ],
    policies: {
      // Your own profile and the profiles of people in your orgs (not every user's email)
      select: policy.any([
        policy.isOwner('id'),
        policy.custom(
          'id IN (SELECT m.user_id FROM org_members m WHERE m.org_id IN '
          + '(SELECT my.org_id FROM org_members my WHERE my.user_id = (SELECT auth.uid())))',
        ),
      ]),
      // Each user creates only their own profile row (never someone else's id/email)
      insert: policy.isOwner('id'),
      update: policy.isOwner('id'),
      delete: policy.none(),
    },
  }),

  // ---- Organizations (tenants) ----
  organizations: table({
    columns: {
      id: 'uuid',
      name: 'text',
      slug: { type: 'text', unique: true },
      owner_id: 'uuid',
      logo_url: 'text?',
      plan: "enum('free','pro','enterprise')",
      settings: 'jsonb?',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: {
      owner_id: 'profiles.id',
    },
    triggers: [
      trigger.updatedAt('updated_at'),
      trigger.auditLog({ table: 'audit_log' }),
      // The creator becomes the first admin. SECURITY DEFINER: org_members has
      // no "bootstrap" INSERT rule that a user could replay later.
      trigger.custom({
        name: 'add_owner_as_admin',
        events: ['after_insert'],
        security: 'definer',
        functionBody: `
          INSERT INTO public.org_members (org_id, user_id, role) VALUES (NEW.id, NEW.owner_id, 'admin');
          RETURN NEW;`,
      }),
      // RLS cannot compare OLD and NEW: freeze the owner column with a trigger
      trigger.lockColumns({ columns: ['owner_id'] }),
    ],
    // Using centralized permissions
    policies: permissions.policiesFor('organizations'),
  }),

  // ---- Org Members (join table for multi-tenancy) ----
  org_members: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      user_id: 'uuid',
      role: "enum('admin','manager','member','viewer')",
      invited_by: 'uuid?',
      joined_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    references: {
      org_id: 'organizations.id',
      user_id: 'profiles.id',
      invited_by: 'profiles.id',
    },
    onDelete: { org_id: 'cascade' },                   // deleting an org removes its memberships
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    // Admins change roles, never who/where the membership is
    triggers: [trigger.lockColumns({ columns: ['org_id', 'user_id'] })],
    policies: {
      // Members see the org's members; everyone sees their own rows (needed by
      // INSERT ... RETURNING, which the SDK's create() uses)
      select: policy.any([orgMember(), policy.isOwner('user_id')]),
      // Nobody inserts memberships directly: joining an org needs the person's
      // consent. The first admin comes from organizations' add_owner_as_admin
      // trigger; everyone else joins through the accept_invitation RPC (both
      // SECURITY DEFINER). A direct "admins add anyone" rule would let any user
      // create an org, add a stranger and read their profile as an "org mate".
      insert: policy.none(),
      // Only admins can change roles (WITH CHECK: still an admin of the new org_id)
      update: orgMember(['admin']),
      // Admins remove members; anyone can leave
      delete: policy.any([orgMember(['admin']), policy.isOwner('user_id')]),
    },
  }),

  // ---- Projects ----
  projects: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      name: 'text',
      description: 'text?',
      status: "enum('active','archived','completed')",
      created_by: 'uuid',
      is_public: 'boolean',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: {
      org_id: 'organizations.id',
      created_by: 'profiles.id',
    },
    // Soft delete: DELETE sets deleted_at instead of removing the row. Only
    // DELETE (judged by the delete policy) can set it — not a plain UPDATE.
    softDelete: 'deleted_at',
    triggers: [
      trigger.updatedAt('updated_at'),
      trigger.auditLog({ table: 'audit_log', columns: ['name', 'status'] }),
      // A project never changes creator or org
      trigger.lockColumns({ columns: ['created_by', 'org_id'] }),
    ],
    policies: permissions.policiesFor('projects'),
  }),

  // ---- Tasks ----
  tasks: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      project_id: 'uuid',
      title: 'text',
      description: 'text?',
      status: "enum('todo','in_progress','review','done')",
      priority: "enum('low','medium','high','critical')",
      assignee_id: 'uuid?',
      reporter_id: 'uuid',
      due_date: 'date?',
      estimated_hours: 'float?',
      tags: 'text[]?',
      position: 'int',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: {
      org_id: 'organizations.id',
      project_id: 'projects.id',
      assignee_id: 'profiles.id',
      reporter_id: 'profiles.id',
    },
    triggers: [
      trigger.updatedAt('updated_at'),
      trigger.auditLog({ table: 'audit_log' }),
      // Nobody re-attributes a task or moves it to another org
      trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
      // Assignees may only move their task along (status/position);
      // org admins and managers may change anything
      trigger.lockColumns({
        name: 'assignee_scope',
        except: ['status', 'position'],
        unless: IS_ORG_ADMIN_OR_MANAGER,
      }),
      // Foreign keys only check existence: keep the project inside the task's org
      trigger.custom({
        name: 'same_org_project',
        events: ['before_insert', 'before_update'],
        functionBody: `
          IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
            RAISE EXCEPTION 'project % does not belong to org %', NEW.project_id, NEW.org_id USING ERRCODE = '23503';
          END IF;
          RETURN NEW;`,
      }),
      // Custom trigger: validate status transitions
      trigger.custom({
        name: 'validate_status_transition',
        events: ['before_update'],
        when: 'OLD.status IS DISTINCT FROM NEW.status',
        functionBody: `
          IF OLD.status = 'done' AND NEW.status = 'todo' THEN
            RAISE EXCEPTION 'Cannot move a done task back to todo';
          END IF;
          RETURN NEW;`,
      }),
    ],
    policies: {
      ...permissions.policiesFor('tasks'),
      // The reporter is whoever creates the task (assignee is set by others)
      insert: policy.withCheck(permissions.can('tasks', 'create'), policy.isOwner('reporter_id')),
    },
  }),

  // ---- Comments ----
  comments: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      task_id: 'uuid',
      author_id: 'uuid',
      body: 'text',
      edited: 'boolean',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: {
      org_id: 'organizations.id',
      task_id: 'tasks.id',
      author_id: 'profiles.id',
    },
    softDelete: 'deleted_at',
    triggers: [
      trigger.updatedAt('updated_at'),
      // A comment stays on its task (and org)
      trigger.lockColumns({ columns: ['org_id', 'task_id'] }),
      trigger.custom({
        name: 'same_org_task',
        events: ['before_insert'],
        functionBody: `
          IF NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.org_id = NEW.org_id) THEN
            RAISE EXCEPTION 'task % does not belong to org %', NEW.task_id, NEW.org_id USING ERRCODE = '23503';
          END IF;
          RETURN NEW;`,
      }),
    ],
    // Mix: centralized permissions + withCheck for insert validation
    policies: {
      select: permissions.can('comments', 'read'),
      // can('comments', 'create') already pins author_id = auth.uid() and org membership
      insert: permissions.can('comments', 'create'),
      update: policy.withCheck(
        permissions.can('comments', 'update'),       // USING: authors (own comments)
        policy.custom('edited = true'),              // WITH CHECK: still the author, in the same org, AND edited = true
      ),
      delete: permissions.can('comments', 'delete'),
    },
  }),

  // ---- Audit Log (append-only) ----
  // Columns match what trigger.auditLog() inserts: table_name, operation,
  // old_data, new_data, changed_at (`accessnexus validate` checks this).
  audit_log: table({
    columns: {
      id: 'bigint',
      table_name: 'text',
      operation: 'text',
      old_data: 'jsonb?',
      new_data: 'jsonb?',
      changed_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    policies: {
      // Platform staff only: global app role from the JWT app_metadata.role
      // (set server-side with auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } }))
      select: policy.hasRole('admin'),
      insert: policy.none(),  // only the audit trigger writes (it runs as SECURITY DEFINER)
      update: policy.none(),  // rows are immutable
      delete: policy.none(),
    },
  }),

  // ---- Invitations ----
  invitations: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      email: 'text',
      role: "enum('manager','member','viewer')",
      invited_by: 'uuid',
      token: { type: 'text', unique: true },
      expires_at: 'timestamptz',
      accepted_at: 'timestamptz?',
      created_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    references: {
      org_id: 'organizations.id',
      invited_by: 'profiles.id',
    },
    onDelete: { org_id: 'cascade' },
    triggers: [
      // Auto-expire invitations after 7 days
      trigger.custom({
        name: 'set_expiry',
        events: ['before_insert'],
        functionBody: `
          IF NEW.expires_at IS NULL THEN
            NEW.expires_at = NOW() + interval '7 days';
          END IF;
          RETURN NEW;`,
      }),
    ],
    policies: {
      // The invitee (by email) and the org's admins/managers can see an invitation
      select: policy.any([
        policy.custom("email = ((SELECT auth.jwt()) ->> 'email')"),
        orgMember(['admin', 'manager']),
      ]),
      insert: policy.all([
        orgMember(['admin', 'manager']),
        policy.isOwner('invited_by'),
        // Managers cannot invite managers
        policy.any([orgMember(['admin']), policy.custom("role IN ('member', 'viewer')")]),
      ]),
      update: policy.none(),  // accepted through the accept_invitation RPC
      delete: orgMember(['admin']),
    },
  }),
}, {
  // ============================================
  // 3. RPCs (PostgreSQL functions)
  // ============================================
  rpcs: {
    // Dashboard stats for an org
    get_org_dashboard: rpc({
      args: { p_org_id: 'uuid' },
      returns: 'jsonb',
      body: `
        RETURN (
          SELECT json_build_object(
            'total_projects', (SELECT count(*) FROM projects WHERE org_id = p_org_id AND deleted_at IS NULL),
            'total_tasks', (SELECT count(*) FROM tasks WHERE org_id = p_org_id),
            'tasks_done', (SELECT count(*) FROM tasks WHERE org_id = p_org_id AND status = 'done'),
            'total_members', (SELECT count(*) FROM org_members WHERE org_id = p_org_id),
            'overdue_tasks', (SELECT count(*) FROM tasks WHERE org_id = p_org_id AND due_date < CURRENT_DATE AND status != 'done')
          )
        );`,
    }),

    // Accept an invitation by token
    accept_invitation: rpc({
      args: { p_token: 'text' },
      returns: 'uuid',
      security: 'definer',
      body: `
        DECLARE
          v_invitation invitations%ROWTYPE;
          v_member_id uuid;
        BEGIN
          IF (SELECT auth.uid()) IS NULL THEN
            RAISE EXCEPTION 'Sign in to accept an invitation' USING ERRCODE = '42501';
          END IF;
          SELECT * INTO v_invitation FROM invitations
            WHERE token = p_token AND accepted_at IS NULL AND expires_at > NOW();
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or expired invitation';
          END IF;
          -- Only the invited address can accept (the token alone is not enough)
          IF lower(v_invitation.email) IS DISTINCT FROM lower((SELECT auth.jwt()) ->> 'email') THEN
            RAISE EXCEPTION 'This invitation was sent to another email address';
          END IF;
          -- ...and only once that address is confirmed (projects with "Confirm email"
          -- off would otherwise let anyone sign up with the invitee's address)
          IF NOT EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid()) AND u.email_confirmed_at IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Confirm your email address before accepting an invitation' USING ERRCODE = '42501';
          END IF;

          -- Each enum column has its own type: cast invitations.role to org_members.role
          INSERT INTO org_members (id, org_id, user_id, role, invited_by)
          VALUES (gen_random_uuid(), v_invitation.org_id, (SELECT auth.uid()), v_invitation.role::text::org_members_role_enum, v_invitation.invited_by)
          RETURNING id INTO v_member_id;

          UPDATE invitations SET accepted_at = NOW() WHERE id = v_invitation.id;
          RETURN v_member_id;
        END;`,
      language: 'plpgsql',
    }),

    // Search tasks with full-text
    search_tasks: rpc({
      args: { p_org_id: 'uuid', p_query: 'text', p_limit: 'int' },
      returns: 'jsonb',
      body: `
        RETURN (
          SELECT json_agg(t) FROM (
            SELECT * FROM tasks
            WHERE org_id = p_org_id
              AND (title ILIKE '%' || p_query || '%' OR description ILIKE '%' || p_query || '%')
            ORDER BY created_at DESC
            LIMIT COALESCE(p_limit, 20)
          ) t
        );`,
    }),
  },
});

export default schema;
