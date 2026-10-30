# Security model

Supabase serves your tables over HTTP to anyone holding the project's anon key, and that key ships inside every browser bundle. Row-Level Security is the only thing between that key and your data. AccessNexus exists to make the generated RLS correct by construction, and to flag the schema choices that would make it wrong.

This page lists what the generator guarantees, the rules you (or your agent) must not break, what `validate` checks, and what is outside AccessNexus' reach.

## What the generator guarantees

These hold for every schema, with no option to turn them off (except `enableRLS: false`, below).

### RLS is enabled and forced on every table

```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
```

`FORCE` applies the policies to the table's owner as well, so only roles with `BYPASSRLS` (on Supabase: `postgres`, the service role) skip them.

### No policy means no access

AccessNexus fails closed:

- A table without `policies` is deny-all for the API: `anon` and `authenticated` get nothing. Only the service role and `SECURITY DEFINER` code reach it. `validate` warns `NO_POLICIES`.
- Once a table has `policies`, an operation without a rule is denied. `{ select: policy.isOwner('user_id') }` allows reads of your rows and no writes at all.
- The only way to open a table is an explicit `enableRLS: false`, which `validate` reports as `RLS_DISABLED`.

### Auth calls are evaluated once per query

Every builder emits `(SELECT auth.uid())` and `(SELECT auth.jwt())`, never the bare call. Postgres turns the subquery into an initPlan and evaluates it once per statement instead of once per row, which on large tables is the difference between milliseconds and seconds.

```sql
USING ((SELECT auth.uid()) = user_id)
```

Raw SQL you write yourself (`policy.custom`, RPC bodies, `lockColumns({ unless })`) is emitted as written. `validate` warns `UNWRAPPED_AUTH_CALL` when it finds a bare call there.

### Reads and writes are checked separately

| Operation | Generated clause | Meaning |
| --- | --- | --- |
| `select` | `USING (rule)` | which rows are visible |
| `delete` | `USING (rule)` | which rows can be deleted |
| `insert` | `WITH CHECK (rule)` | what may be written |
| `update` | `USING (rule)` **and** `WITH CHECK (rule)` | which rows can be targeted, and what they may become |

`UPDATE` always carries an explicit `WITH CHECK`, so an update can never move a row out of the rule (for example, change `user_id` to someone else's id). `policy.withCheck(using, check)` writes `WITH CHECK (using AND check)`: the written row must pass both. Only `{ mode: 'replace' }` drops `using` from `WITH CHECK`, for rows that may legitimately leave it.

### Policies target the narrowest role

A `select` policy is granted `TO public` only when some branch can be true for an anonymous visitor (`policy.public()`, `policy.custom(...)`, a column-to-column `matchesField`); otherwise `TO authenticated`. Write policies are `TO public` only when an explicit `policy.public()` decides them. You never pick the role: the predicate does.

### Membership checks cannot recurse or be called by strangers

`policy.belongsTo(..., { table, foreignKey, localKey })` and `definePermissions` tenants compile to a helper function:

```sql
CREATE OR REPLACE FUNCTION accessnexus_org_members_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_org_members_belongs_to_1_fn(uuid) TO authenticated;
```

- `SECURITY DEFINER` lets a policy on `org_members` consult `org_members` without re-entering its own RLS (no infinite recursion).
- `SET search_path = pg_catalog, public` and the schema-qualified `public.org_members` stop a caller from shadowing objects through their search path.
- `EXECUTE` is revoked from `PUBLIC` and `anon`. A helper used by a policy that also admits anonymous visitors (`TO public`) is granted to `anon` too, which is safe because it returns false when `auth.uid()` is null.

### Writes are pinned in `definePermissions`

By default:

- `create` also requires `ownerColumn = (SELECT auth.uid())`: nobody creates rows attributed to someone else (`pinOwnerOnCreate`).
- `update`, and `create` when its level is not already tenant-scoped, also require membership of the row's (new) tenant: an owner cannot move a row into another org (`pinTenant`).

Both stay on unless you set `pinOwnerOnCreate: false` or `pinTenant: false`. See [Permissions](/guide/permissions).

### Trigger and RPC functions are hardened

- `trigger.auditLog` and `trigger.softDelete` functions are `SECURITY DEFINER` with `SET search_path = pg_catalog, public` and schema-qualified targets. The audit table keeps `insert: policy.none()`, so users cannot forge entries.
- A soft-delete guard rejects a plain `UPDATE` by an API user that sets or clears the soft-delete column. Only `DELETE`, judged by the delete policy, can soft-delete a row.
- `security: 'definer'` RPCs get `REVOKE EXECUTE ... FROM PUBLIC, anon` and a grant to `authenticated` and `service_role`, unless `allowAnon: true`.
- Every generated function pins `search_path`.

### Literals are quoted and identifiers are validated

- Every string value that ends up in SQL (`hasRole('admin')`, `belongsTo` `where` values, the column lists of `auditLog` and `lockColumns`) goes through a quoting function that doubles single quotes.
- Table, column and RPC names are emitted unquoted, so `validate` and the builders only accept lowercase snake_case that is not a reserved SQL keyword (`INVALID_IDENTIFIER`, `RESERVED_IDENTIFIER`).

### Global roles come from a claim users cannot set

`policy.hasRole('admin')` and role arrays in `definePermissions` read `app_metadata.role` from the JWT. Only the server can set `app_metadata` (`supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })` with the service role, or a custom access token hook). The top-level JWT `role` claim, which is the Postgres role `authenticated`, is never used.

### `push` will not create helpers that break silently

The definer helpers rely on their owner bypassing RLS. `push` checks that the connected role has `BYPASSRLS` (or is a superuser) whenever the SQL contains `SECURITY DEFINER`, and refuses with `PUSH_ROLE_NO_BYPASSRLS` before applying anything. Without that check, every membership-checked query would fail with `stack depth limit exceeded`.

## Rules you must not break

These come straight from the agent reference that ships in the package (`node_modules/accessnexus/llms.txt`). Each one closes a hole that the generator cannot close for you, because it depends on what your data means.

### Keep every table closed by default

- Every table the client reads or writes has `policies`. Use `policy.none()` for operations that must be blocked.
- Never "fix" a permission error by removing policies, adding `enableRLS: false`, or using `policy.public()` for writes.
- Never use `policy.public()` (or `'public'` in `definePermissions`) for insert, update or delete unless anonymous writes were asked for (`PUBLIC_WRITE`).
- The `select` rule must admit rows the user just inserted or updated. The SDK's `create` and `update` return the row (`INSERT/UPDATE ... RETURNING`), which fails with an RLS error otherwise. On a membership table, add `policy.isOwner('user_id')` to `select`.

### Do not leak private columns

- Never put private columns (email, phone, address) in a table whose `select` is `policy.isAuthenticated()` or `policy.public()`. On Supabase anyone can sign up, so "signed in" means "anyone".
- RLS cannot restrict columns. Use a separate table for private data, readable with `policy.isOwner(...)`.

### Pin who owns a row

- A table keyed by the user id (`profiles.id` referencing `auth.users.id`) inserts with `policy.isOwner('id')`, never `policy.isAuthenticated()`, which lets anyone create another user's row (`USER_ROW_INSERT_OPEN`).
- `policy.isOwner` columns are `uuid` and reference `auth.users.id` or `profiles.id` (`OWNER_COLUMN_NOT_UUID`).
- Keep the write pins of `definePermissions`. Disable one only for a concrete reason, and then pin the right column yourself.
- Freeze owner, creator and tenant columns with `trigger.lockColumns`. An `UPDATE` rule never does it, because RLS is row-level.

### Get tenants and roles right

- Org or team roles are tenant roles (`{ scope: 'tenant', roles }`, or `belongsTo` with `where: { role: [...] }`), not `policy.hasRole`, which is platform-wide (`GLOBAL_ROLE_IN_TENANT_TABLE`).
- Membership checks go through `belongsTo` with a membership table, or `definePermissions` tenants. Do not re-implement them with `policy.custom` subqueries on the same table: that recurses. Trigger conditions such as `lockColumns({ unless })` are the exception; they run as the caller, outside any policy.
- Never use `belongsTo(col)` without a membership table while users can write `profiles.<col>` (`BELONGS_TO_PROFILE_WRITABLE`): a user would set their own `org_id` and join any tenant.
- A tenant-scoped row that references another tenant-scoped row (tasks pointing at projects) needs a same-tenant guard trigger (`TENANT_PARENT_UNCHECKED`). Foreign keys are checked without RLS. See the [recipe](/guide/cookbook#child-of-a-tenant-resource).
- Never let a member grant a role equal to or above their own. Restrict inserts and updates of the membership table, for example with `policy.custom("role = 'member'")` for editors.
- Never add a "bootstrap" INSERT rule on the membership table ("the creator may add themselves as owner"). It stays valid forever, so a removed creator can rejoin. Add the first member with a `security: 'definer'` AFTER INSERT trigger on the tenant table.

### Membership needs consent when it reveals people

::: danger Visibility derived from sharing a tenant
"Org mates can see my profile" is only private if joining an org needs the person's consent. If admins may insert any `user_id` into the membership table, anyone can create an org, add a stranger, and read that stranger's data as a "co-member".

When co-members can read each other's personal data, add people only through an accepted invitation: a `security: 'definer'` RPC that checks the invited, **confirmed** email, with the membership table's `insert` set to `policy.none()`. Otherwise, keep personal columns out of what co-members can read. See [Invitation-based membership](/guide/cookbook#invitation-based-membership-consent).
:::

### Raw SQL is your responsibility

- Never write a bare `auth.uid()` / `auth.jwt()` in `policy.custom` or RPC bodies. Always `(SELECT auth.uid())`.
- `security: 'definer'` RPCs and triggers, and the service role, bypass RLS: check the caller inside (see [RPCs](/guide/rpcs#check-the-caller-inside-a-definer-function)). In a definer body, schema-qualify tables (`public.team_members`).
- Use `withCheck(using, check)` to add conditions on the written row. Only use `{ mode: 'replace' }` when the row may legitimately leave `using`.
- Do not edit generated SQL to change behavior. Change the schema and regenerate. Applied migrations are immutable; `push` refuses drift.

## What `validate` warns about

`validate` (also run by `generate`, `diff` and `push`) checks the schema statically. Errors stop the command; warnings are printed and must be treated as bugs unless the choice is deliberate.

| Code | Severity | What it catches |
| --- | --- | --- |
| `NO_POLICIES` | warning | Table is deny-all for the API. Fine for server-only tables; a bug if the client uses it. |
| `RLS_DISABLED` | warning | `enableRLS: false`: the table is open to the anon key. |
| `RLS_DISABLED_WITH_POLICIES` | error | `enableRLS: false` plus policies that would never apply. |
| `PUBLIC_WRITE` | warning | Insert, update or delete open to anonymous visitors through `policy.public()`. |
| `USER_ROW_INSERT_OPEN` | warning | A user-keyed table anyone signed in can insert into. Use `policy.isOwner('id')`. |
| `TENANT_PARENT_UNCHECKED` | warning | A child row can point at another tenant's parent. Add the same-tenant guard. |
| `BELONGS_TO_PROFILE_WRITABLE` | error | Tenant lookup through a profile column users can write. |
| `GLOBAL_ROLE_IN_TENANT_TABLE` | warning | `hasRole` mixed with tenant checks on one table; usually meant as a tenant role. |
| `UNWRAPPED_AUTH_CALL` | warning | Bare `auth.uid()` / `auth.jwt()` / `auth.role()` in custom SQL, an RPC body or a `lockColumns` condition. |
| `AUDIT_INSERT_OPEN` | warning | Users can insert into the audit table, so they can forge entries. |
| `AUDIT_TABLE_MISMATCH` | error | The audit table lacks the columns the audit trigger writes. |
| `OWNER_COLUMN_NOT_UUID` | error | `isOwner` on a column that is not `uuid`. |
| `UNKNOWN_COLUMN`, `UNKNOWN_TABLE` | error | A policy, trigger, reference or index names something that does not exist. TypeScript does not catch these in manual mode. |
| `INVALID_IDENTIFIER`, `RESERVED_IDENTIFIER` | error | A name that cannot be emitted unquoted. |
| `INVALID_ENUM_VALUE` | error | A `belongsTo` `where` value (for example a misspelled role) that is not in the membership column's enum. |

The complete list, with fixes, is in [Troubleshooting](/guide/troubleshooting#schema-validation-issues).

`validate` cannot prove that a policy expresses what you meant. It checks structure, not intent: an `isOwner` on the wrong column, or a definer RPC that forgets to check the caller, passes.

## What AccessNexus does not protect

::: warning Outside the generator's reach
- **Column-level reads.** RLS decides which rows a user sees, never which columns. If a user can read a row, they can read every column of it. Split private data into its own table. (`trigger.lockColumns` restricts which columns can be *written*, not read.)
- **The service role.** The `service_role` key and the `postgres` connection bypass RLS completely. Keep them on the server; never in a browser bundle, a mobile app, or a public repository.
- **Definer code you write.** `security: 'definer'` RPCs and triggers run with the owner's rights. Their safety is exactly as good as the checks in their body.
- **Raw SQL you write.** `policy.custom()`, `lockColumns({ unless })` and RPC bodies are emitted verbatim.
- **Objects outside the schema.** Policies created in the dashboard or by other migrations, functions you wrote by hand, storage buckets, and other schemas are not managed. Postgres ORs permissive policies, so an old permissive policy would keep granting access next to the generated ones: on the tables the schema manages, `push` refuses with `FOREIGN_POLICIES` until you review them and pass `--replace-foreign-policies`. Policies on tables outside the schema are left alone.
- **Rules removed from the schema.** In v0.1.6, `push` re-creates the policies the schema declares but does not drop a generated policy whose operation you removed (for example deleting `delete:` from a table's `policies`), and does not drop removed triggers or RPCs. To revoke access, set the operation to `policy.none()` instead of deleting the key, or drop the old object by hand.
- **Supabase's default grants.** Tables and invoker RPCs keep Supabase's default grants (`anon` and `authenticated` can call them); RLS is what protects the rows inside.
- **Soft-deleted rows.** They stay visible through RLS; only the SDK filters them. Add `deleted_at IS NULL` to `select` if raw API reads must not see them.
:::

## Related

- [Policies](/guide/policies) and [Permissions](/guide/permissions)
- [RPCs](/guide/rpcs): checking the caller in definer code
- [Examples](/guide/cookbook): the rules above, applied
- [Existing projects](/guide/existing-project): how imported policies are kept fail-closed
- [Troubleshooting](/guide/troubleshooting)
- [Limits & roadmap](/guide/limits)
