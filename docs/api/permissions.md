# definePermissions

Centralized RBAC: declare who may read, create, update and delete each resource once, then turn it into table policies. Guide: [Permissions and tenants](/guide/permissions).

```ts
function definePermissions<R extends string>(input: PermissionsInput<R>): PermissionsDef<R>;
```

`R` is inferred from the keys of `resources`, so `policiesFor` and `can` accept only declared resource names.

```ts
import { defineSchema, definePermissions, policy, table } from 'accessnexus';

export const permissions = definePermissions({
  roles: ['admin', 'manager', 'member'],
  tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
  resources: {
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },
      create: { scope: 'tenant', roles: ['admin', 'manager'] },
      update: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
      delete: { scope: 'tenant', roles: ['admin'] },
    },
  },
});

export default defineSchema({
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: "enum('admin','manager','member')" },
    primaryKey: 'id',
    policies: { select: policy.isOwner('user_id') },
  }),
  projects: table({
    columns: { id: 'uuid', org_id: 'uuid', created_by: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: permissions.policiesFor('projects'),
  }),
});
```

## PermissionsInput

```ts
interface PermissionsInput<R extends string = string> {
  roles: string[];
  tenant?: TenantConfig;
  resources: Record<R, ResourcePermissions>;
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `roles` | `string[]` | required | Every role name used anywhere in `resources` (global role arrays and tenant `roles`). Used only for validation. |
| `tenant` | `TenantConfig` | `undefined` | Membership table. Required when any resource uses `{ scope: 'tenant' }`. |
| `resources` | `Record<R, ResourcePermissions>` | required | One entry per table, keyed by table name. |

## TenantConfig

```ts
interface TenantConfig {
  table: string;
  userColumn: string;
  tenantColumn: string;
  roleColumn?: string;
}
```

| Field | Type | Description |
| --- | --- | --- |
| `table` | `string` | Membership (join) table, e.g. `'org_members'`. |
| `userColumn` | `string` | Membership column holding the user id. |
| `tenantColumn` | `string` | Membership column holding the tenant id. |
| `roleColumn` | `string` | Membership column holding the user's role inside the tenant. Required by `{ scope: 'tenant', roles }`. |

## ResourcePermissions

```ts
interface ResourcePermissions {
  ownerColumn?: string;
  tenantColumn?: string;
  pinTenant?: boolean;
  pinOwnerOnCreate?: boolean;
  read?: PermissionLevel;
  create?: PermissionLevel;
  update?: PermissionLevel;
  delete?: PermissionLevel;
  all?: PermissionLevel;
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `ownerColumn` | `string` | `undefined` | Column holding the owner's user id (`uuid`). Required by `'own'`. |
| `tenantColumn` | `string` | `undefined` | Column on this table holding the tenant id (`uuid`). Required by `{ scope: 'tenant' }`. Use `'id'` for the tenant table itself. |
| `pinTenant` | `boolean` | `true` | Writes must keep the row in a tenant the user belongs to. See [Write pins](#write-pins). |
| `pinOwnerOnCreate` | `boolean` | `true` | `create` requires `ownerColumn = auth.uid()`. See [Write pins](#write-pins). |
| `read` | `PermissionLevel` | none | Compiles to the `select` policy. |
| `create` | `PermissionLevel` | none | Compiles to the `insert` policy. |
| `update` | `PermissionLevel` | none | Compiles to the `update` policy. |
| `delete` | `PermissionLevel` | none | Compiles to the `delete` policy. |
| `all` | `PermissionLevel` | none | Fills `read`, `create`, `update` and `delete` that have no level of their own: `{ ownerColumn: 'user_id', all: 'own', read: '*' }`. Write pins apply to the expanded `create`/`update` as if written out. |

An action left out produces no policy, so it is denied once the table has policies.

## PermissionLevel

```ts
type PermissionLevel = '*' | 'public' | 'none' | 'own' | string[] | TenantScope | AnyPermission;

interface TenantScope { scope: 'tenant'; roles?: string[] }
interface AnyPermission { any: PermissionLevel[] }
```

| Level | Meaning | Compiles to |
| --- | --- | --- |
| `'public'` | everyone, including anonymous visitors | `policy.public()` |
| `'*'` | any signed-in user | `policy.isAuthenticated()` |
| `'none'` | nobody through the API | `policy.none()` |
| `'own'` | the row owner | `policy.isOwner(ownerColumn)` |
| `[]` | nobody | `policy.none()` |
| `['admin']` | global app role (JWT `app_metadata.role`) | `policy.hasRole('admin')` |
| `['admin', 'staff']` | any of these global app roles | `policy.any([policy.hasRole('admin'), policy.hasRole('staff')])` |
| `{ scope: 'tenant' }` | member of the row's tenant | `policy.belongsTo(tenantColumn, { table, foreignKey: tenant.tenantColumn, localKey: tenant.userColumn })` |
| `{ scope: 'tenant', roles: ['admin'] }` | member with one of these roles in the tenant | same, with `where: { [tenant.roleColumn]: ['admin'] }` |
| `{ any: [...] }` | OR of the levels | `policy.any([...])` (a single entry is not wrapped) |

::: warning
A role array (`['admin']`) is a global app role read from `app_metadata.role`, not a role inside an org or team. For "org admins" use `{ scope: 'tenant', roles: ['admin'] }`. `validate` warns `GLOBAL_ROLE_IN_TENANT_TABLE` when a table mixes both.
:::

## Write pins

`create` and `update` levels other than `'public'` and `'none'` get extra conditions on the written row. The level's rule stays in `USING`; the pins are AND-ed into `WITH CHECK` through [`policy.withCheck(rule, pins)`](/api/policy#withcheck) (default `'and'` mode, so the rule itself also stays in `WITH CHECK`).

| Pin | Applies to | Condition added | Applied when |
| --- | --- | --- | --- |
| tenant | `create`, `update` | `belongsTo(tenantColumn, tenant)` (membership, no role filter) | `pinTenant !== false`, `tenant` is configured, `tenantColumn` is set, the level is not itself a top-level `{ scope: 'tenant' }`, and not (`create` with `tenantColumn: 'id'`) |
| owner | `create` only | `isOwner(ownerColumn)` | `ownerColumn` is set, `pinOwnerOnCreate !== false`, and the level is not `'own'` |

Two pins are combined with `policy.all`.

- `pinOwnerOnCreate: false` — when others assign the owner column (for example a task's `assignee_id`). Pin the real creator column yourself.
- `pinTenant: false` — for resources written by non-members (a customer booking into a shop).

::: warning
The pins stop a user from creating rows attributed to someone else and from moving a row into another tenant. Disable one only for a concrete reason, and pin the right column yourself.
:::

## Errors

Thrown as `Error` with a `[AccessNexus]` message (the CLI reports `SCHEMA_INVALID`).

At `definePermissions(...)`:

| Condition | Message |
| --- | --- |
| A resource uses `{ scope: 'tenant' }` (directly or inside `{ any }`) and `tenant` is missing | `Some resources use { scope: 'tenant' } but no tenant config was provided` |
| A role in a role array or in tenant `roles` is not in `roles` | `Unknown role "<role>" in <resource>.<action>. Available roles: ...` |

At `policiesFor(...)` / `can(...)`:

| Condition | Message |
| --- | --- |
| Unknown resource | `Resource "<name>" not found in permissions. Available: ...` |
| `can()` for an action with no level | `No permission defined for <resource>.<action>` |
| `'own'` without `ownerColumn` | `Permission level 'own' requires ownerColumn to be set on the resource` |
| `{ scope: 'tenant' }` without `tenant` | `Permission level { scope: 'tenant' } requires a tenant config in definePermissions()` |
| `{ scope: 'tenant' }` without `tenantColumn` | `Permission level { scope: 'tenant' } requires tenantColumn to be set on the resource` |
| tenant `roles` without `tenant.roleColumn` | `Tenant-scoped roles require tenant.roleColumn to be defined` |

## PermissionsDef

The object returned by `definePermissions`.

```ts
interface PermissionsDef<R extends string = string> {
  readonly roles: readonly string[];
  readonly tenant: TenantConfig | undefined;
  readonly resources: Readonly<Record<R, ResourcePermissions>>;
  can(resource: R, action: 'read' | 'create' | 'update' | 'delete'): PolicyRule;
  policiesFor(resource: R): TablePolicies;
}
```

| Member | Returns | Description |
| --- | --- | --- |
| `roles` | `readonly string[]` | Frozen copy of `input.roles`. |
| `tenant` | `TenantConfig \| undefined` | `input.tenant`. |
| `resources` | `Readonly<Record<R, ResourcePermissions>>` | `input.resources`, frozen. |
| `policiesFor(resource)` | `TablePolicies` | `{ select, insert, update, delete }` for every action that has a level (`read` to `select`, `create` to `insert`). Assign it to a table's `policies`. |
| `can(resource, action)` | `PolicyRule` | The rule for one action, write pins included. Throws when the action has no level. |

`can` is useful to combine a permission with other rules:

```ts
import { definePermissions, policy } from 'accessnexus';

const permissions = definePermissions({
  roles: ['admin'],
  resources: {
    posts: { ownerColumn: 'author_id', read: 'public', create: '*', update: 'own', delete: ['admin'] },
  },
});

export const policies = {
  ...permissions.policiesFor('posts'),
  update: policy.all([permissions.can('posts', 'update'), policy.custom('locked = false')]),
};
```

## Types

All exported from `accessnexus`: `PermissionsInput`, `PermissionsDef`, `ResourcePermissions`, `TenantConfig`, `PermissionLevel`, `TenantScope`, `AnyPermission`.
