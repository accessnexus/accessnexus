# Examples

Complete schemas for common access patterns. Each one is a full `accessnexus.schema.ts`: copy it, run `npx accessnexus validate`, then `diff` and `generate`. They follow the [rules you must not break](/guide/security#rules-you-must-not-break).

## Owner-only table

Each user sees and edits only their own rows.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    indexes: [{ columns: ['user_id'] }],
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

## Public read, authenticated write

Anonymous visitors read published rows; only the author writes. The `select` rule has a branch that needs no user, so its policy is granted `TO public`.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  articles: table({
    columns: { id: 'uuid', author_id: 'uuid', title: 'text', published: 'boolean' },
    primaryKey: 'id',
    references: { author_id: 'auth.users.id' },
    policies: {
      select: policy.any([policy.custom('published = true'), policy.isOwner('author_id')]),
      insert: policy.isOwner('author_id'), // signed in AND writing as themselves
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
});
```

::: warning
Do not "fix" a read problem with `select: policy.public()`: that also exposes drafts.
:::

## Multi-tenant with roles (teams)

Roles live in the membership table. The creator of a team becomes its first owner through a `security: 'definer'` AFTER INSERT trigger, never through an INSERT rule on `team_members` (a removed creator could replay it). Owners add anyone; editors add plain members only.

```ts [accessnexus.schema.ts]
import { definePermissions, defineSchema, policy, table, trigger } from 'accessnexus';

const permissions = definePermissions({
  roles: ['owner', 'editor', 'member'],
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id', roleColumn: 'role' },
  resources: {
    teams: {
      ownerColumn: 'created_by',
      tenantColumn: 'id',                          // the row IS the tenant
      read: { any: ['own', { scope: 'tenant' }] },  // creator sees it before joining
      create: '*',                                  // + created_by = auth.uid()
      update: { scope: 'tenant', roles: ['owner'] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'team_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['owner', 'editor'] },
      update: { any: ['own', { scope: 'tenant', roles: ['owner'] }] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
  },
});

/** Current user is a member of the row's team (optionally with one of `roles`). */
function teamMember(roles?: string[]) {
  return policy.belongsTo('team_id', {
    table: 'team_members', foreignKey: 'team_id', localKey: 'user_id',
    ...(roles ? { where: { role: roles } } : {}),
  });
}

export default defineSchema({
  teams: table({
    columns: { id: 'uuid', name: 'text', created_by: 'uuid' },
    primaryKey: 'id',
    references: { created_by: 'auth.users.id' },
    triggers: [
      trigger.custom({
        name: 'add_creator_as_owner',
        events: ['after_insert'],
        security: 'definer',
        functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
      }),
      trigger.lockColumns({ columns: ['created_by'] }),
    ],
    policies: permissions.policiesFor('teams'),
  }),
  team_members: table({
    columns: { id: 'uuid', team_id: 'uuid', user_id: 'uuid', role: "enum('owner','editor','member')" },
    primaryKey: 'id',
    references: { team_id: 'teams.id', user_id: 'auth.users.id' },
    onDelete: { team_id: 'cascade' },
    indexes: [{ columns: ['team_id', 'user_id'], unique: true }],
    triggers: [trigger.lockColumns({ columns: ['team_id', 'user_id'] })],
    policies: {
      // Own rows too: INSERT ... RETURNING must see the new row
      select: policy.any([teamMember(), policy.isOwner('user_id')]),
      insert: policy.any([
        teamMember(['owner']),                                                  // owners add anyone
        policy.all([teamMember(['editor']), policy.custom("role = 'member'")]), // editors add members only
      ]),
      update: teamMember(['owner']),
      delete: policy.any([teamMember(['owner']), policy.isOwner('user_id')]),  // owners remove, anyone leaves
    },
  }),
  projects: table({
    columns: { id: 'uuid', team_id: 'uuid', created_by: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { team_id: 'teams.id', created_by: 'auth.users.id' },
    onDelete: { team_id: 'cascade' },
    triggers: [trigger.lockColumns({ columns: ['created_by', 'team_id'] })],
    policies: permissions.policiesFor('projects'),
  }),
});
```

Owners add people directly here, which is fine only because co-members see nothing personal about each other. If they can, use invitations (next recipe).

## Invitation-based membership (consent)

When org mates can read each other's profiles, nobody may be added to an org without agreeing. Memberships are created only by the owner trigger and by `accept_invitation`, which checks the invited, confirmed email. `org_members.insert` is `policy.none()`.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table, trigger } from 'accessnexus';

function orgMember(roles?: string[]) {
  return policy.belongsTo('org_id', {
    table: 'org_members', foreignKey: 'org_id', localKey: 'user_id',
    ...(roles ? { where: { role: roles } } : {}),
  });
}
const orgAdmin = policy.belongsTo('id', {
  table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] },
});

export default defineSchema({
  orgs: table({
    columns: { id: 'uuid', name: 'text', owner_id: 'uuid' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    triggers: [
      trigger.custom({
        name: 'add_owner_as_admin',
        events: ['after_insert'],
        security: 'definer',
        functionBody: "INSERT INTO public.org_members (org_id, user_id, role) VALUES (NEW.id, NEW.owner_id, 'admin'); RETURN NEW;",
      }),
      trigger.lockColumns({ columns: ['owner_id'] }),
    ],
    policies: {
      select: policy.any([
        policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }),
        policy.isOwner('owner_id'), // INSERT ... RETURNING runs before the trigger's membership exists
      ]),
      insert: policy.isOwner('owner_id'),
      update: orgAdmin,
      delete: orgAdmin,
    },
  }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    onDelete: { org_id: 'cascade' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    triggers: [trigger.lockColumns({ columns: ['org_id', 'user_id'] })],
    policies: {
      select: policy.any([orgMember(), policy.isOwner('user_id')]),
      insert: policy.none(), // consent: only the owner trigger and accept_invitation add members
      update: orgMember(['admin']),
      delete: policy.any([orgMember(['admin']), policy.isOwner('user_id')]),
    },
  }),
  invitations: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      email: 'text',
      role: "enum('admin','member')",
      invited_by: 'uuid',
      token: { type: 'text', unique: true, default: 'gen_random_uuid()::text' },
      expires_at: { type: 'timestamptz', default: "now() + interval '7 days'" },
      accepted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', invited_by: 'auth.users.id' },
    onDelete: { org_id: 'cascade' },
    policies: {
      select: policy.any([
        policy.custom("email = ((SELECT auth.jwt()) ->> 'email')"), // the invitee
        orgMember(['admin']),
      ]),
      insert: policy.all([orgMember(['admin']), policy.isOwner('invited_by')]),
      update: policy.none(), // accepted only through accept_invitation
      delete: orgMember(['admin']),
    },
  }),
}, {
  rpcs: {
    accept_invitation: rpc({
      args: { p_token: 'text' },
      returns: 'uuid',
      security: 'definer',
      body: `
        DECLARE
          v_inv public.invitations%ROWTYPE;
          v_member_id uuid;
        BEGIN
          IF (SELECT auth.uid()) IS NULL THEN
            RAISE EXCEPTION 'Sign in to accept an invitation' USING ERRCODE = '42501';
          END IF;
          SELECT * INTO v_inv FROM public.invitations
            WHERE token = p_token AND accepted_at IS NULL AND expires_at > NOW();
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Invalid or expired invitation';
          END IF;
          -- Only the invited address, and only once it is confirmed
          IF lower(v_inv.email) IS DISTINCT FROM lower((SELECT auth.jwt()) ->> 'email') THEN
            RAISE EXCEPTION 'This invitation was sent to another email address' USING ERRCODE = '42501';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid()) AND u.email_confirmed_at IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'Confirm your email address first' USING ERRCODE = '42501';
          END IF;
          -- Each enum column has its own type: cast through text
          INSERT INTO public.org_members (org_id, user_id, role)
          VALUES (v_inv.org_id, (SELECT auth.uid()), v_inv.role::text::org_members_role_enum)
          RETURNING id INTO v_member_id;
          UPDATE public.invitations SET accepted_at = NOW() WHERE id = v_inv.id;
          RETURN v_member_id;
        END;`,
    }),
  },
});
```

The token alone is not enough: the email check stops a leaked link, and the confirmation check stops someone who signed up with the invitee's address on a project where "Confirm email" is off.

## Child of a tenant resource

RLS checks each row against its own tenant column, and foreign keys are checked without RLS. So `tasks` carries its own `org_id`, and a trigger keeps it equal to the project's. Without it, a member of org A can attach a task to org B's project (`TENANT_PARENT_UNCHECKED`).

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

const member = policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' });
const memberPolicies = { select: member, insert: member, update: member, delete: member };

export default defineSchema({
  orgs: table({
    columns: { id: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: { select: policy.belongsTo('id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' }) },
  }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','member')" },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    policies: { select: policy.isOwner('user_id') }, // writes: service role / definer RPCs only
  }),
  projects: table({
    columns: { id: 'uuid', org_id: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { org_id: 'orgs.id' },
    triggers: [trigger.lockColumns({ columns: ['org_id'] })],
    policies: memberPolicies,
  }),
  tasks: table({
    columns: { id: 'uuid', org_id: 'uuid', project_id: 'uuid', title: 'text' },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', project_id: 'projects.id' },
    onDelete: { project_id: 'cascade' },
    triggers: [
      // Runs as the writing user: another org's project is invisible, so it
      // is reported exactly like a project that does not exist.
      trigger.custom({
        name: 'same_org_project',
        events: ['before_insert', 'before_update'],
        functionBody: `
          IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
            RAISE EXCEPTION 'project % not found in org %', NEW.project_id, NEW.org_id USING ERRCODE = '23503';
          END IF;
          RETURN NEW;`,
      }),
      trigger.lockColumns({ name: 'lock_tenant', columns: ['org_id', 'project_id'] }),
    ],
    policies: memberPolicies,
  }),
});
```

The same applies to deeper levels (comments under tasks check `tasks.org_id`).

## Let a user change only some columns

RLS decides which rows a user may update, never which columns. Lock the rest with `trigger.lockColumns`.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  tickets: table({
    columns: {
      id: 'uuid',
      org_id: 'uuid',
      reporter_id: 'uuid',
      assignee_id: 'uuid?',
      title: 'text',
      status: { type: "enum('open','doing','done')", default: "'open'" },
    },
    primaryKey: 'id',
    references: { reporter_id: 'auth.users.id', assignee_id: 'auth.users.id' },
    triggers: [
      // Nobody re-attributes a ticket or moves it to another org
      trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
      // The assignee may only change status; the reporter may change anything else
      trigger.lockColumns({
        name: 'assignee_scope',
        except: ['status'],
        unless: 'OLD.reporter_id = (SELECT auth.uid())',
      }),
    ],
    policies: {
      select: policy.any([policy.isOwner('reporter_id'), policy.isOwner('assignee_id')]),
      insert: policy.isOwner('reporter_id'),
      update: policy.any([policy.isOwner('reporter_id'), policy.isOwner('assignee_id')]),
      delete: policy.isOwner('reporter_id'),
    },
  }),
});
```

A locked column change raises SQLSTATE `42501`. For a multi-step change that must stay consistent, prefer a definer [RPC](/guide/rpcs).

## Audit log

`trigger.auditLog` writes `(table_name, operation, old_data, new_data, changed_at)` from a `SECURITY DEFINER` function. The audit table blocks API inserts so entries cannot be forged.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  invoices: table({
    columns: { id: 'uuid', owner_id: 'uuid', amount: 'decimal' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    triggers: [trigger.auditLog({ table: 'audit_log' })],
    policies: {
      select: policy.isOwner('owner_id'),
      insert: policy.isOwner('owner_id'),
      update: policy.isOwner('owner_id'),
      delete: policy.none(),
    },
  }),
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
      select: policy.hasRole('admin'), // platform staff (app_metadata.role)
      insert: policy.none(),           // only the trigger writes
      update: policy.none(),           // append-only
      delete: policy.none(),
    },
  }),
});
```

## Soft delete

`softDelete: 'deleted_at'` turns `DELETE` into `SET deleted_at = NOW()`, judged by the delete policy. A guard stops API users from setting or clearing the column with a plain `UPDATE`. Soft-deleted rows stay visible through RLS (only the SDK filters them), so exclude them in `select`. Restore goes through a definer RPC.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  posts: table({
    columns: {
      id: 'uuid',
      author_id: 'uuid',
      title: 'text',
      published: { type: 'boolean', default: 'false' },
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { author_id: 'auth.users.id' },
    softDelete: 'deleted_at',
    policies: {
      select: policy.all([
        policy.custom('deleted_at IS NULL'),
        policy.any([policy.isOwner('author_id'), policy.custom('published = true')]),
      ]),
      insert: policy.isOwner('author_id'),
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
}, {
  rpcs: {
    restore_post: rpc({
      args: { p_id: 'uuid' },
      security: 'definer',
      body: `
        IF (SELECT auth.uid()) IS NULL THEN
          RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501';
        END IF;
        UPDATE public.posts SET deleted_at = NULL
          WHERE id = p_id AND author_id = (SELECT auth.uid());`,
    }),
  },
});
```

Do not combine `onDelete: 'cascade'` into a soft-delete table (`CASCADE_INTO_SOFT_DELETE`): use `'restrict'` and soft-delete the children first.

## Row-set RPC

`returns: { table: { ... } }` emits `RETURNS TABLE(...)` and types the SDK result as an array of rows. The invoker function runs under the caller's RLS, so it only sees the caller's bookings anyway; the `WHERE` keeps the plan tight. `policies.all` gives the owner every operation, and `delete: policy.none()` takes one back.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  bookings: table({
    columns: { id: 'uuid', user_id: 'uuid', date_time: 'timestamptz', services: 'json' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: { all: policy.isOwner('user_id'), delete: policy.none() },
  }),
}, {
  rpcs: {
    my_bookings: rpc({
      returns: { table: { booking_id: 'uuid', date_time: 'timestamptz', services: 'json' } },
      language: 'sql',
      volatility: 'stable',
      body: `SELECT id, date_time, services FROM public.bookings
             WHERE user_id = (SELECT auth.uid()) ORDER BY date_time`,
    }),
  },
});
```

```ts [src/bookings.ts]
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js';

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function upcoming() {
  const { data, error } = await db.rpc.my_bookings({});
  if (error) throw error;
  return data; // { booking_id: string; date_time: string; services: Json }[]
}
```

To return whole rows of a table use `{ setof: 'bookings' }` (SDK `Bookings[]`). Changing the result columns later is handled by `push`: see [Changing or removing an RPC](/guide/rpcs#changing-or-removing-an-rpc).

## Related

- [Security model](/guide/security)
- [Policies](/guide/policies), [Permissions](/guide/permissions), [Triggers](/guide/triggers), [RPCs](/guide/rpcs)
- [Troubleshooting](/guide/troubleshooting)
