# Policies

A table's `policies` decide who can read and write which rows. You give one rule per operation, built with `policy.*`, and AccessNexus compiles each rule into a Postgres RLS policy. This page explains the model and every builder, with the SQL it produces.

For roles and multi-tenant rules shared across tables, see [Permissions](/guide/permissions), which compiles to the same builders.

## The model

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: { id: 'uuid', user_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      select: policy.isOwner('user_id'), // which rows are visible
      insert: policy.isOwner('user_id'), // what may be written
      update: policy.isOwner('user_id'), // which rows may be targeted, and what they may become
      delete: policy.isOwner('user_id'), // which rows may be deleted
    },
  }),
});
```

Postgres RLS has two kinds of clause, and each operation uses them differently:

| Operation | `USING` (existing rows) | `WITH CHECK` (the row being written) |
| --- | --- | --- |
| `select` | Which rows are visible | - |
| `insert` | - | Which new rows are allowed |
| `update` | Which rows the user may target | What the row may look like afterwards |
| `delete` | Which rows may be deleted | - |

For `update`, AccessNexus always emits an explicit `WITH CHECK` with the same rule as `USING`, so the updated row must still satisfy the rule: an owner cannot set `user_id` to someone else and hand the row away. The check is visible in the generated SQL instead of relying on Postgres reusing `USING` implicitly. Use [`policy.withCheck`](#policy-withcheck-using-check-options) to add conditions on the written row.

Rules of thumb:

- **An operation without a rule is denied.** Leaving `delete` out is the same as `delete: policy.none()`, but writing `none()` makes it explicit.
- **A table without `policies` is deny-all** for the API. Every table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- **Policy keys are `select`, `insert`, `update`, `delete`.** `read` / `create` are [permission](/guide/permissions) actions; used here they fail with `UNKNOWN_POLICY_OPERATION`.

### Which role a policy targets

You never set the Postgres role (`TO ...`). The predicate decides it:

- A `select` policy is granted `TO public` when some branch can be true for an anonymous visitor (`policy.public()`, `policy.custom(...)`, a column-to-column `matchesField`). Otherwise it is `TO authenticated`.
- Write policies are `TO public` only when an explicit `policy.public()` decides them. Otherwise `TO authenticated`.

So `select: policy.any([policy.custom('published = true'), policy.isOwner('author_id')])` really is readable by signed-out visitors, while `insert: policy.isOwner('author_id')` is not.

### Generated policy names

Policies are named `<prefix>_<table>_<operation>`, e.g. `accessnexus_notes_select`. Change the prefix with `naming.policyPrefix` in `accessnexus.config.ts` or `--prefix`. Each policy file drops and recreates its own policies, so re-applying it is safe.

## Builders at a glance

| Builder | Compiles to |
| --- | --- |
| `policy.isAuthenticated()` | `(SELECT auth.uid()) IS NOT NULL` |
| `policy.public()` | `TRUE` |
| `policy.none()` | `FALSE` |
| `policy.isOwner(col)` | `(SELECT auth.uid()) = col` |
| `policy.hasRole(role)` | `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'role'` |
| `policy.belongsTo(col, through)` | A `SECURITY DEFINER` membership helper called with `col` |
| `policy.matchesField(a, b)` | `a = b` |
| `policy.custom(sql)` | `sql`, as written |
| `policy.any([...])` | `(...) OR (...)` |
| `policy.all([...])` | `(...) AND (...)` |
| `policy.withCheck(using, check, options?)` | `USING (using)`, `WITH CHECK (using AND check)` |

The SQL below is copied from real `generate` output. Header comments and the `DROP POLICY IF EXISTS` line before each `CREATE POLICY` are omitted.

## `policy.isAuthenticated()`

Any signed-in user.

```ts
import { policy } from 'accessnexus';

export const signedIn = policy.isAuthenticated();
```

```sql
CREATE POLICY "accessnexus_drafts_insert"
  ON drafts FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
  );
```

::: danger Not for user-keyed inserts
On Supabase anyone can sign up, so "signed in" is a low bar. For a table keyed by the user id (`profiles.id` → `auth.users.id`), `insert: policy.isAuthenticated()` lets any user create **another user's** row. Use `policy.isOwner('id')`. `validate` warns `USER_ROW_INSERT_OPEN`.

Also never put private columns (email, phone, address) in a table whose `select` is `isAuthenticated()` or `public()`: every account could list them.
:::

## `policy.public()`

Everyone, including anonymous visitors. Use it for reads only.

```ts
import { policy } from 'accessnexus';

export const everyone = policy.public();
```

```sql
CREATE POLICY "accessnexus_announcements_select"
  ON announcements FOR SELECT
  TO public
  USING (
    TRUE
  );
```

::: danger
`policy.public()` on `insert`, `update` or `delete` lets anyone with your anon key write to the table. `validate` warns `PUBLIC_WRITE`. Only use it when anonymous writes were explicitly asked for.
:::

## `policy.none()`

Nobody through the API. The service role, triggers and `SECURITY DEFINER` code bypass RLS and still work.

```ts
import { policy } from 'accessnexus';

export const nobody = policy.none();
```

```sql
CREATE POLICY "accessnexus_drafts_delete"
  ON drafts FOR DELETE
  TO authenticated
  USING (
    FALSE
  );
```

Typical uses: `delete: policy.none()` on profiles, and `insert` / `update` / `delete: policy.none()` on an append-only audit table that only a trigger writes.

## `policy.isOwner(column)`

The row belongs to the current user. The column must be a `uuid`, usually referencing `auth.users.id` or `profiles.id` (`OWNER_COLUMN_NOT_UUID` otherwise).

```ts
import { policy } from 'accessnexus';

export const owner = policy.isOwner('user_id');
```

```sql
CREATE POLICY "accessnexus_notes_select"
  ON notes FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
  );
```

`auth.uid()` is wrapped in a subquery so Postgres evaluates it once per query instead of once per row.

## `policy.hasRole(role)`

A **global** application role, read from the JWT `app_metadata.role` claim.

```ts
import { policy } from 'accessnexus';

// Only platform staff
export const platformAdmin = policy.hasRole('admin');
```

```sql
CREATE POLICY "accessnexus_announcements_insert"
  ON announcements FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin'
  );
```

`app_metadata` can only be set server-side, for example with the service role: `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })`, or a custom access token hook. The top-level JWT `role` claim is never used: on Supabase it is the Postgres role (`authenticated`).

::: warning Global role, not org role
"Admins of this organization" is a **tenant** role stored in your membership table. Use `belongsTo` with `where` or `{ scope: 'tenant', roles }` in [Permissions](/guide/permissions). `validate` warns `GLOBAL_ROLE_IN_TENANT_TABLE` when a table mixes both.
:::

## `policy.belongsTo(column, through)`

The current user is a member of the row's group (org, team, workspace). Pass the membership table as `through`:

| `through` field | Meaning |
| --- | --- |
| `table` | Membership table, e.g. `'org_members'` |
| `foreignKey` | Its column holding the group id, e.g. `'org_id'` |
| `localKey` | Its column holding the user id, e.g. `'user_id'` |
| `where` | Optional extra filters, e.g. `{ role: ['admin', 'manager'] }` |

```ts
import { policy } from 'accessnexus';

export const member = policy.belongsTo('org_id', {
  table: 'org_members', foreignKey: 'org_id', localKey: 'user_id',
});

export const orgAdmin = policy.belongsTo('org_id', {
  table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] },
});
```

The membership lookup becomes a hardened helper function, called from the policy:

```sql
CREATE OR REPLACE FUNCTION accessnexus_orgs_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_orgs_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_orgs_belongs_to_1_fn(uuid) TO authenticated;

CREATE POLICY "accessnexus_orgs_select"
  ON orgs FOR SELECT
  TO authenticated
  USING (
    (SELECT accessnexus_orgs_belongs_to_1_fn(id))
  );
```

With `where: { role: ['admin'] }` the helper adds `AND role IN ('admin')`. A `where` value that is not in the membership column's enum (a misspelled role) fails `validate` with `INVALID_ENUM_VALUE`.

Why a `SECURITY DEFINER` function: a policy on `org_members` that queries `org_members` would recurse into its own RLS. The helper runs as its owner, skips RLS for that one lookup, has a pinned `search_path`, and is not executable by `anon`. If a policy that uses it is also granted `TO public`, the helper is granted to `anon` too, which is safe because it returns false without a user.

::: tip Do not rewrite membership checks with `policy.custom`
A subquery on the membership table inside a custom policy brings back the recursion problem and skips the hardening. Use `belongsTo` or `definePermissions` tenants.
:::

### Without `through`

`policy.belongsTo('org_id')` with no second argument checks `profiles.org_id` of the current user:

```sql
SELECT EXISTS (SELECT 1 FROM public.profiles WHERE org_id = p_value AND id = (SELECT auth.uid()));
```

::: danger Only safe when users can never write that profile column
If a user can insert or update their own `profiles.org_id`, they set it to another tenant's id and join that tenant. `validate` rejects this case with `BELONGS_TO_PROFILE_WRITABLE`. To keep the profiles lookup, make the column server-written only: `insert: policy.none()` on profiles (create them from an auth trigger or the service role) and `trigger.lockColumns({ columns: ['org_id'] })`. Prefer a membership table.
:::

## `policy.matchesField(a, b)`

Two values must be equal. Either side can be a column or an auth call such as `'auth.uid()'`, which is wrapped automatically.

```ts
import { policy } from 'accessnexus';

export const sameUser = policy.matchesField('author_id', 'auth.uid()');
```

```sql
CREATE POLICY "accessnexus_drafts_select"
  ON drafts FOR SELECT
  TO authenticated
  USING (
    author_id = (SELECT auth.uid())
  );
```

## `policy.custom(sql)`

A raw SQL predicate, emitted as written. It is the escape hatch for conditions on the row's own columns.

```ts
import { policy } from 'accessnexus';

export const published = policy.custom("status = 'published'");
```

::: warning
- Always write `(SELECT auth.uid())`, never a bare `auth.uid()` or `auth.jwt()`. `validate` warns `UNWRAPPED_AUTH_CALL`.
- Column names inside custom SQL are not checked. Prefer a semantic builder when one fits.
- A `select` rule with a custom branch is granted `TO public`: make sure that branch is meant for anonymous visitors.
:::

## `policy.any([...])` and `policy.all([...])`

`any` is OR, `all` is AND. They nest.

```ts
import { policy } from 'accessnexus';

export const ownerOrPublished = policy.any([policy.custom('published = true'), policy.isOwner('author_id')]);

export const adminAuthor = policy.all([
  policy.isOwner('author_id'),
  policy.belongsTo('org_id', { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id', where: { role: ['admin'] } }),
]);
```

```sql
CREATE POLICY "accessnexus_articles_select"
  ON articles FOR SELECT
  TO public
  USING (
    (published = true)
    OR ((SELECT auth.uid()) = author_id)
  );

CREATE POLICY "accessnexus_articles_insert"
  ON articles FOR INSERT
  TO authenticated
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
    AND ((SELECT accessnexus_articles_belongs_to_1_fn(org_id)))
  );
```

An empty list fails `validate` with `EMPTY_COMBINATOR`.

## `policy.withCheck(using, check, options?)`

Separates "which rows may I target" from "what may I write". By default the written row must pass **both** rules, so the ownership or tenant condition in `using` can never be written away.

```ts
import { policy } from 'accessnexus';

// Authors edit their own articles, and every edit must set edited = true
export const editOwn = policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true'));
```

```sql
CREATE POLICY "accessnexus_articles_update"
  ON articles FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = author_id
  )
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
    AND (edited = true)
  );
```

With `{ mode: 'replace' }`, `WITH CHECK` is the second rule only. Use it when the row may legitimately leave the `using` condition, such as publishing a draft:

```ts
import { policy } from 'accessnexus';

export const publishDraft = policy.withCheck(
  policy.all([policy.isOwner('author_id'), policy.custom("status = 'draft'")]),
  policy.all([policy.isOwner('author_id'), policy.custom("status IN ('draft', 'published')")]),
  { mode: 'replace' },
);
```

```sql
CREATE POLICY "accessnexus_drafts_update"
  ON drafts FOR UPDATE
  TO authenticated
  USING (
    ((SELECT auth.uid()) = author_id)
    AND (status = 'draft')
  )
  WITH CHECK (
    ((SELECT auth.uid()) = author_id)
    AND (status IN ('draft', 'published'))
  );
```

::: warning Keep ownership in the replacement rule
In `replace` mode, anything you leave out of the second rule is no longer enforced on the written row. Repeat the ownership or tenant condition there, as above.
:::

`withCheck` is meant for `update` and `insert`. On `insert` there is no `USING`, so both rules go into `WITH CHECK`. On `delete`, which has only `USING`, the `check` rule has no effect.

## Pitfalls

### The `select` rule must admit what the user just wrote

The SDK's `create` and `update` return the row (`INSERT ... RETURNING`, `UPDATE ... RETURNING`). Postgres checks the returned row against the `select` policy, so a user who may insert but not read the row gets an RLS error. On a membership table, add `policy.isOwner('user_id')` to `select` so a new member can see their own row.

### RLS cannot restrict columns

An `update` rule decides **which rows** a user may change, never **which columns**. `update: policy.isOwner('assignee_id')` also lets the assignee rewrite the title, the reporter or the tenant. Freeze columns with [`trigger.lockColumns`](/guide/triggers#trigger-lockcolumns).

### Do not fix permission errors by opening the table

Never "fix" an RLS error by removing policies, adding `enableRLS: false` or using `policy.public()` for a write. Write the correct rule instead.

## Next steps

- [Permissions](/guide/permissions) - roles and tenants defined once, applied per table
- [Triggers](/guide/triggers) - column locks and other row-level logic RLS cannot express
- [Security model](/guide/security) - every rule the generated SQL follows
- [Policy API](/api/policy) - full signatures and types
