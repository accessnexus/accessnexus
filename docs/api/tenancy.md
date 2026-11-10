# defineEnum / tenantInvitations

Building blocks for multi-tenant schemas: a Postgres enum shared by columns and RPCs, and a consent-based way into a tenant. Both are exported from `accessnexus`. Guides: [Permissions & tenants](/guide/permissions) and [Examples](/guide/cookbook#invitation-based-membership-consent). A full schema that uses them ships in the repository as `examples/saas-teams/`.

```ts
import { defineEnum, tenantInvitations } from 'accessnexus';
```

## defineEnum

Declare one Postgres enum that several columns and RPCs share. Per-column `enum('a','b')` types create one Postgres type per column, so comparing two of them needs casts through text; a shared enum is a single `CREATE TYPE`.

```ts
defineEnum<const TValues extends readonly string[]>(name: string, values: TValues): EnumDef<TValues>;

interface EnumDef<TValues extends readonly string[] = readonly string[]> {
  readonly name: string;
  readonly values: TValues;
  readonly type: `enum:${string}`;      // 'enum:<name>'
  readonly nullable: `enum:${string}?`; // 'enum:<name>?'
}
```

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `string` | Postgres type name, lowercase snake_case. |
| `values` | `readonly string[]` | The enum values, in order. |

Using it takes two steps:

1. Register it: `defineSchema(tables, { enums: [role] })` ([`options.enums`](/api/schema#defineschema)). A name that is used but not declared is `UNKNOWN_ENUM`.
2. Use `role.type` (or `role.nullable`) as a column type, an RPC `args` type or a `returns.table` type.

What it generates and how it types:

| Where | Result |
| --- | --- |
| Migration | One idempotent `CREATE TYPE <name> AS ENUM (...)` before the tables, shared by every user. |
| Column | `role: { type: memberRole.type, default: "'member'" }` is a column of type `<name>`. `default` is raw SQL, so the literal keeps its own quotes. |
| RPC | `args: { p_role: memberRole.type }` and `returns: { table: { role: memberRole.type } }`. An RPC type may also be `'table.column'` (that column's type, enum union included). |
| SDK | The values as a union, and `Database['public']['Enums'][<name>]`. |

```ts
import { defineEnum, defineSchema, policy, rpc, table } from 'accessnexus';

export const memberRole = defineEnum('member_role', ['owner', 'admin', 'member', 'viewer']);

export default defineSchema({
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: { type: memberRole.type, default: "'member'" } },
    primaryKey: 'id',
    policies: { select: policy.isOwner('user_id') },
  }),
}, {
  enums: [memberRole],
  rpcs: {
    members_with_role: rpc({
      args: { p_org: 'uuid', p_role: memberRole.type },
      returns: { table: { user_id: 'uuid', role: memberRole.type } },
      language: 'sql',
      volatility: 'stable',
      body: 'SELECT user_id, role FROM public.org_members WHERE org_id = p_org AND role = p_role;',
    }),
  },
});
```

## tenantInvitations

Invitations into a tenant (an org, a team, a workspace): the consent-based way to add a member. It returns a table and two RPCs to spread into `defineSchema`.

```ts
tenantInvitations(options: TenantInvitationsOptions): {
  table: TableDef;
  rpcs: Record<string, RpcDef>;
  tableName: string;
};
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `tenant` | `{ table, userColumn, tenantColumn, roleColumn }` | required | The membership table, as in [`definePermissions`](/api/permissions#tenantconfig); `roleColumn` is required here. |
| `tenantTable` | `string` | required | The tenant table the invitations belong to: the foreign key target (primary key `id`). |
| `tenantNameColumn` | `string` | `undefined` | Column of `tenantTable` that `my_invitations` shows as `tenant_name`, e.g. `'name'`. Without it the result has no `tenant_name`. |
| `roles` | `EnumDef` or `readonly string[]` | required | Roles an invitation may carry: a shared [`defineEnum`](#defineenum) (also the membership column's type) or a list of values. |
| `inviterRoles` | `Record<string, readonly string[]>` | required | Which roles may invite, and which roles each may hand out: `{ owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] }`. |
| `roleType` | `string` | the shared enum, or `<tenant.table>_<roleColumn>_enum` | SQL type of the membership role column, used to cast the role when joining. |
| `requireConfirmedEmail` | `boolean` | `true` | Accepting needs a confirmed e-mail in `auth.users`. |
| `table` | `string` | `'invitations'` | Name of the invitations table. |
| `rpcNames` | `{ accept?: string; mine?: string }` | `accept_invitation` / `my_invitations` | Names of the two RPCs. |

The last role of `roles` (the lowest by convention) is the default of the `role` column.

### The table

`invitations(id, <tenantColumn>, email, role, invited_by, created_at)`, with the tenant column named after `tenant.tenantColumn`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `<tenantColumn>` | `uuid` | References `<tenantTable>.id`, `ON DELETE CASCADE`. |
| `email` | `text` | Check: lower-case and shaped like an e-mail. Unique per tenant. |
| `role` | the `roles` enum | The role the invitee joins with. |
| `invited_by` | `uuid` | References `auth.users.id`, `ON DELETE CASCADE`. |
| `created_at` | `timestamptz` | Default `now()`. |

Indexes: unique `(<tenantColumn>, email)`, and `(email)`. Policies:

| Operation | Who |
| --- | --- |
| `select` | The inviters (members of the tenant whose role is a key of `inviterRoles`), and the invitee (the e-mail in the JWT matches `email`). |
| `insert` | An inviter, in their own name (`invited_by` is the caller) and only for the roles their entry in `inviterRoles` allows. |
| `update` | Nobody. An invitation is never edited. |
| `delete` | The inviters (revoke) and the invitee (decline). |

### The RPCs

| RPC | Security | Signature | Behavior |
| --- | --- | --- | --- |
| `accept_invitation` | definer | `(p_invitation uuid) => uuid` | The caller must be signed in, have a confirmed e-mail (unless `requireConfirmedEmail: false`) and match the invitation's e-mail. They join the tenant with the invited role (nothing is inserted if they already are a member), the invitation is consumed, and the tenant id is returned. |
| `my_invitations` | definer, stable | `() => table` | The caller's invitations: `{ id, <tenantColumn>, tenant_name?, role, created_at }`, oldest first. It exists because an invitee cannot read the tenant yet, so the name has to come from a definer function. |

Both RPCs are `REVOKE`d from `PUBLIC` and `anon` like every `security: 'definer'` RPC.

| Error | SQLSTATE | When |
| --- | --- | --- |
| `sign in first` | `42501` | `accept_invitation` called without a user (anon). |
| `confirm your e-mail first` | `42501` | The user's e-mail is not confirmed (`auth.users.email_confirmed_at`). |
| `invitation not found` | `P0002` | The id does not exist, or the invitation is for another e-mail. |

```ts
import { defineEnum, defineSchema, policy, table, tenantInvitations } from 'accessnexus';

export const memberRole = defineEnum('member_role', ['owner', 'admin', 'member', 'viewer']);

const invites = tenantInvitations({
  tenant: { table: 'org_members', userColumn: 'user_id', tenantColumn: 'org_id', roleColumn: 'role' },
  tenantTable: 'orgs',
  tenantNameColumn: 'name',
  roles: memberRole,
  inviterRoles: { owner: ['admin', 'member', 'viewer'], admin: ['member', 'viewer'] },
});

export default defineSchema({
  orgs: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
  org_members: table({
    columns: { id: 'uuid', org_id: 'uuid', user_id: 'uuid', role: { type: memberRole.type, default: "'member'" } },
    primaryKey: 'id',
    references: { org_id: 'orgs.id', user_id: 'auth.users.id' },
    indexes: [{ columns: ['org_id', 'user_id'], unique: true }],
    policies: { select: policy.isOwner('user_id'), insert: policy.none() },
  }),
  invitations: invites.table,
}, { enums: [memberRole], rpcs: { ...invites.rpcs } });
```

The membership table keeps `insert: policy.none()`: people enter only through `accept_invitation`, which is what makes the join consensual. In the app:

```ts
const { data: pending } = await db.rpc.my_invitations();   // [{ id, org_id, tenant_name, role, created_at }]
const { data: orgId } = await db.rpc.accept_invitation({ p_invitation: pending![0].id });
```

Finer rules (seat limits, allowed e-mail domains) need your own table or a wrapper RPC.
