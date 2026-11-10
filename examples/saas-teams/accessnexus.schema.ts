// ============================================
// AccessNexus - SaaS teams example (multi-tenant)
// A task manager where everything lives inside an org, built from the
// multi-tenant builders: no hand-written SQL for the usual tenant rules.
//
// In your project, import from 'accessnexus' instead of '../../src/index.js'.
// ============================================
//
//   orgs ─┬─ org_members   who belongs, with a role: owner > admin > member > viewer
//         ├─ invitations   the only way in: an invite the person accepts themselves
//         ├─ projects
//         └─ tasks ── project_id → projects (same org), assignee_id → a member
//   profiles               created on sign-up, visible only to people who share an org
//
//                      owner  admin  member  viewer
//   read everything      ✓      ✓      ✓       ✓
//   tasks / projects     ✓      ✓      ✓       ·      (create, edit)
//   delete any task      ✓      ✓      own     ·
//   delete project       ✓      ✓      ·       ·
//   invite               any    member/viewer  ·  ·
//   rename org           ✓      ✓      ·       ·
//   delete org           ✓      ·      ·       ·

import {
  defineEnum,
  definePermissions,
  defineSchema,
  policy,
  rpc,
  table,
  tenantInvitations,
  trigger,
} from '../../src/index.js';

/** One role type for memberships, invitations and RPC results (no casts). */
export const memberRole = defineEnum('member_role', ['owner', 'admin', 'member', 'viewer']);

const membership = { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id' };

const permissions = definePermissions({
  roles: ['owner', 'admin', 'member', 'viewer'],
  tenant: { ...membership, roleColumn: 'role' },
  resources: {
    orgs: {
      ownerColumn: 'created_by',
      tenantColumn: 'id', // the row IS the tenant
      // 'own': the creator reads the row INSERT ... RETURNING hands back, before
      // the membership trigger runs. A creator later removed still sees that one
      // row, so list workspaces through org_members (see the recipe).
      read: { any: ['own', { scope: 'tenant' }] },
      create: '*',
      update: { scope: 'tenant', roles: ['owner', 'admin'] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['owner', 'admin', 'member'] },
      update: { scope: 'tenant', roles: ['owner', 'admin', 'member'] },
      delete: { scope: 'tenant', roles: ['owner', 'admin'] },
    },
    tasks: {
      ownerColumn: 'user_id',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['owner', 'admin', 'member'] },
      update: { scope: 'tenant', roles: ['owner', 'admin', 'member'] },
      // Owners/admins delete any task; members only their own (and only while
      // still members: a member demoted to viewer loses it).
      delete: {
        any: [
          { scope: 'tenant', roles: ['owner', 'admin'] },
          { all: ['own', { scope: 'tenant', roles: ['member'] }] },
        ],
      },
    },
  },
});

/** The current user is a member of the row's org with one of `roles`. */
const orgRole = (roles: string[]) =>
  policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: roles } });

/** Rows an admin may touch: never an owner or another admin. */
const belowAdmin = policy.custom("role IN ('member', 'viewer')");

const invites = tenantInvitations({
  tenant: { ...membership, roleColumn: 'role' },
  tenantTable: 'orgs',
  tenantNameColumn: 'name',
  roles: memberRole,
  inviterRoles: { owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] },
});

export default defineSchema(
  {
    orgs: table({
      columns: {
        id: 'uuid',
        name: { type: 'text', check: 'char_length(name) BETWEEN 1 AND 80' },
        created_by: 'uuid',
        created_at: { type: 'timestamptz', default: 'now()' },
      },
      primaryKey: 'id',
      references: { created_by: 'auth.users.id' },
      triggers: [
        // The creator becomes the first owner (a trigger, not an INSERT rule on
        // org_members, which would let a removed creator rejoin). `writes` makes
        // the React Query helpers refresh memberships after orgs.create().
        trigger.custom({
          name: 'add_creator_as_owner',
          events: ['after_insert'],
          security: 'definer',
          writes: ['org_members'],
          functionBody: "INSERT INTO public.org_members (org_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
        }),
        trigger.lockColumns({ columns: ['created_by', 'created_at'] }),
      ],
      policies: permissions.policiesFor('orgs'),
    }),

    org_members: table({
      columns: {
        id: 'uuid',
        org_id: 'uuid',
        user_id: 'uuid',
        role: { type: memberRole.type, default: "'member'" },
        created_at: { type: 'timestamptz', default: 'now()' },
      },
      primaryKey: 'id',
      references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
      onDelete: { org_id: 'cascade', user_id: 'cascade' },
      indexes: [{ columns: ['org_id', 'user_id'], unique: true }, { columns: ['user_id'] }],
      triggers: [
        trigger.lockColumns({ columns: ['org_id', 'user_id', 'created_at'] }),
        // The last owner cannot leave, be removed or demoted; deleting the org still cascades.
        trigger.keepAtLeastOne({ column: 'role', value: 'owner', scope: 'org_id', parent: 'orgs.id' }),
      ],
      policies: {
        select: policy.any([policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }), policy.isOwner('user_id')]),
        insert: policy.none(), // memberships come from the org trigger and accept_invitation()
        update: policy.any([orgRole(['owner']), policy.all([orgRole(['admin']), belowAdmin])]),
        delete: policy.any([orgRole(['owner']), policy.all([orgRole(['admin']), belowAdmin]), policy.isOwner('user_id')]),
      },
    }),

    invitations: invites.table,

    profiles: table({
      columns: {
        id: 'uuid',
        display_name: { type: 'text', check: 'char_length(display_name) BETWEEN 1 AND 60' },
        created_at: { type: 'timestamptz', default: 'now()' },
        updated_at: 'timestamptz?',
      },
      primaryKey: 'id',
      references: { id: 'auth.users.id' },
      onDelete: { id: 'cascade' },
      triggers: [
        trigger.updatedAt('updated_at'),
        // Every new user gets a profile on sign-up (no client-side "ensure profile").
        trigger.onAuthUserCreated({
          columns: { id: 'NEW.id', display_name: "coalesce(nullif(split_part(NEW.email, '@', 1), ''), 'user')" },
        }),
      ],
      policies: {
        // Yourself, and people who share an org with you.
        select: policy.any([policy.isOwner('id'), policy.sharesTenant('id', membership)]),
        insert: policy.isOwner('id'),
        update: policy.isOwner('id'),
        delete: policy.none(),
      },
    }),

    projects: table({
      columns: {
        id: 'uuid',
        org_id: 'uuid',
        name: { type: 'text', check: 'char_length(name) BETWEEN 1 AND 80' },
        created_by: 'uuid',
        created_at: { type: 'timestamptz', default: 'now()' },
      },
      primaryKey: 'id',
      references: { org_id: 'orgs.id', created_by: 'auth.users.id' },
      onDelete: { org_id: 'cascade', created_by: 'cascade' },
      indexes: [{ columns: ['org_id', 'name'], unique: true }],
      triggers: [trigger.lockColumns({ columns: ['org_id', 'created_by', 'created_at'] })],
      policies: permissions.policiesFor('projects'),
    }),

    tasks: table({
      columns: {
        id: 'uuid',
        org_id: 'uuid',
        user_id: 'uuid',
        project_id: 'uuid?',
        assignee_id: 'uuid?',
        title: { type: 'text', check: 'char_length(title) BETWEEN 1 AND 200' },
        status: { type: "enum('todo','doing','done')", default: "'todo'" },
        created_at: { type: 'timestamptz', default: 'now()' },
        updated_at: 'timestamptz?',
      },
      primaryKey: 'id',
      references: { org_id: 'orgs.id', user_id: 'auth.users.id', project_id: 'projects.id', assignee_id: 'auth.users.id' },
      onDelete: { org_id: 'cascade', user_id: 'cascade', project_id: 'set null', assignee_id: 'set null' },
      indexes: [{ columns: ['org_id', 'status'] }, { columns: ['project_id'] }, { columns: ['assignee_id'] }],
      triggers: [
        trigger.updatedAt('updated_at'),
        trigger.lockColumns({ columns: ['user_id', 'org_id', 'created_at'] }),
        // Foreign keys ignore RLS: keep the project and the assignee inside the task's org.
        trigger.sameTenant({ column: 'project_id', references: 'projects', tenantColumn: 'org_id' }),
        trigger.memberOfTenant({ column: 'assignee_id', tenant: membership }),
      ],
      policies: permissions.policiesFor('tasks'),
    }),
  },
  {
    enums: [memberRole],
    rpcs: {
      ...invites.rpcs,
      /** Members of an org with their display names. Runs as the caller: RLS decides. */
      org_people: rpc({
        args: { p_org: 'uuid' },
        returns: { table: { user_id: 'uuid', role: memberRole.type, display_name: 'text?', joined_at: 'timestamptz' } },
        language: 'sql',
        volatility: 'stable',
        body: `
          SELECT m.user_id, m.role, p.display_name, m.created_at
          FROM public.org_members m
          LEFT JOIN public.profiles p ON p.id = m.user_id
          WHERE m.org_id = p_org
          ORDER BY m.created_at;`,
      }),
    },
  },
);
