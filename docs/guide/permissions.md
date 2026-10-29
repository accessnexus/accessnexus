# Permissions

`definePermissions` is a central role-based access map. You declare your roles and tenant model once, describe who may read, create, update and delete each resource, and attach the result to tables with `policiesFor`. It compiles to the same [policy builders](/guide/policies), with secure write pins added for you.

Use it when several tables share the same access model, typically a multi-tenant app where users belong to organizations, teams or workspaces.

## A first example

```ts [accessnexus.schema.ts]
import { definePermissions, defineSchema, table } from 'accessnexus';

const permissions = definePermissions({
  roles: ['admin', 'manager', 'member'],
  tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
  resources: {
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },                                   // any org member
      create: { scope: 'tenant', roles: ['admin', 'manager'] },     // + created_by = auth.uid()
      update: { any: ['own', { scope: 'tenant', roles: ['admin'] }] }, // + stays in an org you belong to
      delete: { scope: 'tenant', roles: ['admin'] },
    },
  },
});

export default defineSchema({
  projects: table({
    columns: { id: 'uuid', org_id: 'uuid', created_by: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { created_by: 'auth.users.id' },
    policies: permissions.policiesFor('projects'),
  }),
});
```

A real schema also declares `orgs` and `org_members`; see the [walkthrough](#multi-tenant-walkthrough) below.

## Input

| Field | Description |
| --- | --- |
| `roles` | Every role name used anywhere in `resources`. An unknown role throws when the schema loads |
| `tenant` | The membership table. Required as soon as a resource uses `{ scope: 'tenant' }` |
| `resources` | One entry per table name, with its columns and a level per action |

### `tenant`

| Field | Description |
| --- | --- |
| `table` | Membership table, e.g. `'org_members'` |
| `userColumn` | Its column holding the user id, e.g. `'user_id'` |
| `tenantColumn` | Its column holding the tenant id, e.g. `'org_id'` |
| `roleColumn` | Its column holding the member's role. Required for `{ scope: 'tenant', roles }` |

### Resources

| Field | Description |
| --- | --- |
| `ownerColumn` | Column holding the owner's user id. Required for `'own'` |
| `tenantColumn` | Column holding the row's tenant id. Required for `{ scope: 'tenant' }`. Use `'id'` when the row is the tenant itself |
| `read`, `create`, `update`, `delete` | A permission level per action. An action left out is denied |
| `pinOwnerOnCreate` | Default on. See [Write pins](#write-pins) |
| `pinTenant` | Default on. See [Write pins](#write-pins) |

Actions map to policy operations: `read` → `select`, `create` → `insert`, `update` → `update`, `delete` → `delete`.

## Permission levels

| Level | Who | Compiles to |
| --- | --- | --- |
| `'public'` | Everyone, including anonymous visitors | `policy.public()` |
| `'*'` | Any signed-in user | `policy.isAuthenticated()` |
| `'none'` | Nobody through the API | `policy.none()` |
| `'own'` | The row's owner | `policy.isOwner(ownerColumn)` |
| `{ scope: 'tenant' }` | Any member of the row's tenant | `policy.belongsTo(tenantColumn, { through: tenant })` |
| `{ scope: 'tenant', roles: ['admin'] }` | A member of the row's tenant with one of these roles | Same, filtered on `roleColumn` |
| `['admin']` | Users with this **global** app role (JWT `app_metadata.role`) | `policy.hasRole('admin')`, OR-ed for several roles |
| `{ any: [...] }` | Any of the listed levels | `policy.any([...])` |

::: danger `'public'` and `'*'` for writes
`create: 'public'` lets anyone with the anon key insert rows. `'*'` lets any account do it, and anyone can sign up. Prefer a tenant scope, or keep the owner pin on (the default) so `'*'` at least means "create rows attributed to yourself".
:::

## Global roles vs tenant roles

These are two different things, and mixing them up is a common hole.

| | Tenant role | Global role |
| --- | --- | --- |
| Means | "Admin **of this org**" | "Our platform staff" |
| Stored in | The membership table's `roleColumn` | The JWT `app_metadata.role` claim |
| Set by | Whoever may write the membership table (per your policies) | Server only: `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })` or a custom access token hook |
| Level | `{ scope: 'tenant', roles: ['admin'] }` | `['admin']` |
| Builder | `policy.belongsTo(col, { ..., where: { role: ['admin'] } })` | `policy.hasRole('admin')` |

A bare array like `['admin']` is **not** an org admin: any user with `app_metadata.role = 'admin'` passes it, in every org. `validate` warns `GLOBAL_ROLE_IN_TENANT_TABLE` when a table mixes both kinds.

## Write pins

`create` and `update` get extra conditions on the written row, on by default. They stop the two classic multi-tenant attacks: creating rows in someone else's name, and moving a row into another tenant.

| Pin | Applies to | Adds to `WITH CHECK` | Turn off with |
| --- | --- | --- | --- |
| Owner pin | `create`, when `ownerColumn` is set and the level is not `'public'`, `'none'` or `'own'` | `ownerColumn = (SELECT auth.uid())` | `pinOwnerOnCreate: false` |
| Tenant pin | `update`, and `create` when its level is not already tenant-scoped; never `'public'` / `'none'` levels, never `create` when `tenantColumn` is `'id'` | The user is a member of the row's (new) tenant | `pinTenant: false` |

The `projects` resource above compiles to these insert and update policies (helper functions omitted; `_1_fn` checks membership, `_2_fn` admin or manager, `_3_fn` admin):

```sql
CREATE POLICY "accessnexus_projects_insert"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT accessnexus_projects_belongs_to_2_fn(org_id)))
    AND ((SELECT auth.uid()) = created_by)
  );

CREATE POLICY "accessnexus_projects_update"
  ON projects FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = created_by)
    OR ((SELECT accessnexus_projects_belongs_to_3_fn(org_id)))
  )
  WITH CHECK (
    (((SELECT auth.uid()) = created_by)
    OR ((SELECT accessnexus_projects_belongs_to_3_fn(org_id))))
    AND ((SELECT accessnexus_projects_belongs_to_1_fn(org_id)))
  );
```

Without the tenant pin, the creator of a project (`'own'`) could update its `org_id` to an org they do not belong to.

### When to turn a pin off

Only for a concrete reason, and then pin the right column yourself:

- **`pinOwnerOnCreate: false`** when someone else assigns the owner column, e.g. a manager creating a task whose `ownerColumn` is `assignee_id`. To still record the real creator, add a `created_by` column and pin it yourself: `insert: policy.withCheck(permissions.can('tasks', 'create'), policy.isOwner('created_by'))`.
- **`pinTenant: false`** for resources written by non-members, e.g. customers booking into a shop:

```ts
import { definePermissions } from 'accessnexus';

export const permissions = definePermissions({
  roles: ['admin', 'member'],
  tenant: { table: 'shop_members', userColumn: 'user_id', tenantColumn: 'shop_id', roleColumn: 'role' },
  resources: {
    bookings: {
      ownerColumn: 'client_id',
      tenantColumn: 'shop_id',
      pinTenant: false,                             // customers are not shop members
      read: { any: ['own', { scope: 'tenant' }] },  // the customer, and the shop's staff
      create: '*',                                  // + client_id = auth.uid() (owner pin stays on)
      update: 'own',
      delete: { scope: 'tenant', roles: ['admin'] },
    },
  },
});
```

## `policiesFor` and `can`

```ts
import { definePermissions, policy } from 'accessnexus';

export const permissions = definePermissions({
  roles: ['owner', 'editor', 'viewer'],
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id', roleColumn: 'role' },
  resources: {
    documents: {
      ownerColumn: 'created_by',
      tenantColumn: 'team_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['owner', 'editor'] },
      update: { any: ['own', { scope: 'tenant', roles: ['owner'] }] },
      delete: { scope: 'tenant', roles: ['owner'] },
    },
  },
});

// Every declared action, as a table's `policies`
export const documentPolicies = permissions.policiesFor('documents');

// One rule, to combine with other builders
export const readable = policy.any([permissions.can('documents', 'read'), policy.custom('shared = true')]);
```

| Method | Returns | Notes |
| --- | --- | --- |
| `policiesFor(resource)` | `{ select?, insert?, update?, delete? }` | Actions you did not declare are left out, so they are denied |
| `can(resource, action)` | One policy rule, pins included | Throws when the action is not declared |

Both accept only declared resource names: `policiesFor('documnets')` is a type error.

## Multi-tenant walkthrough

A team workspace: users create teams, the creator becomes the first owner, owners manage members, and projects belong to a team.

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
      // The creator becomes the first owner (runs as the table owner, bypassing RLS)
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
    triggers: [trigger.lockColumns({ columns: ['team_id', 'user_id'] })], // owners change roles only
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

What each piece does:

1. **`teams`** is its own tenant (`tenantColumn: 'id'`). Any signed-in user may create one, but only as themselves (owner pin). `read` includes `'own'` because the SDK's `create` returns the new row, and that `INSERT ... RETURNING` is checked before the membership row exists.
2. **The first owner** is added by a `security: 'definer'` `AFTER INSERT` trigger, not by an INSERT rule on `team_members`. A rule like "the creator may add themselves as owner" stays valid forever, so a creator removed by the other owners could replay it to rejoin.
3. **`team_members`** is written by owners, and editors may only add plain members. Nobody can grant a role above their own.
4. **`lockColumns`** keeps who and where a row belongs fixed. RLS cannot restrict columns, so without it an owner could rewrite `team_id` or `user_id` on a membership row.
5. **`projects`** follows the permission map; the pins keep `created_by` honest and stop a project from moving to a team the user is not in.

App flow: `db.teams.create({ name, created_by: user.id })` makes the user an owner; owners then add people with `db.team_members.create({ team_id, user_id, role })`.

::: warning Visibility derived from sharing a tenant needs consent
If co-members can read each other's personal data (a profile with name and email), adding someone to a team must require their consent. Otherwise anyone can create a team, add a stranger by user id and read their data as a "co-member". In that case set the membership table's `insert` to `policy.none()` and add people only through an accepted invitation, for example a `security: 'definer'` RPC that checks the invited, confirmed email. See the [Cookbook](/guide/cookbook).
:::

::: tip Child rows need a same-tenant guard
RLS checks each row against its own tenant column, and foreign keys are checked without RLS. A `tasks` row with its own `team_id` that points at a project of another team passes both. Add a guard trigger that checks the parent's tenant; `validate` warns `TENANT_PARENT_UNCHECKED` when it is missing. The pattern is in the [Cookbook](/guide/cookbook).
:::

## Next steps

- [Policies](/guide/policies) - the builders permissions compile to
- [Triggers](/guide/triggers) - `lockColumns` and definer triggers used above
- [Cookbook](/guide/cookbook) - invitations, child resources, column-scoped updates
- [Permissions API](/api/permissions) - full types
