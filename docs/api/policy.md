# policy

Builders for the row-level access rule of each operation in a table's `policies`. Guide: [Policies](/guide/policies).

```ts
import { policy } from 'accessnexus';
```

Each builder returns a plain rule object (`{ kind, ... }`). The [SupabaseAdapter](/api/adapter) compiles it to a Postgres RLS policy.

## How a rule becomes a policy

One policy per operation, named `<prefix>_<table>_<operation>` (prefix default `accessnexus`), preceded by `DROP POLICY IF EXISTS` (unless `adapterOptions.idempotent` is `false`):

| Operation | Clauses |
| --- | --- |
| `select` | `USING (<rule>)` |
| `insert` | `WITH CHECK (<check of rule>)` |
| `update` | `USING (<rule>)` and an explicit `WITH CHECK (<check of rule>)` |
| `delete` | `USING (<rule>)` |

For every builder except `withCheck`, the check expression equals the rule expression, so an UPDATE can never move a row out of the rule. An operation left out of `policies` has no policy and is denied (RLS is on).

```sql
DROP POLICY IF EXISTS "accessnexus_posts_update" ON posts;
CREATE POLICY "accessnexus_posts_update"
  ON posts FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = author_id
  )
  WITH CHECK (
    (SELECT auth.uid()) = author_id
  );
```

### Target role (`TO ...`)

AccessNexus picks the role; the predicate always decides access.

| Operation | `TO public` when | Otherwise |
| --- | --- | --- |
| `select` | some branch can be true without a signed-in user: `policy.public()`, `policy.custom(...)`, or a `matchesField` with no `auth.` call on either side (`any` needs one such branch, `all` needs every branch) | `TO authenticated` |
| `insert`, `update`, `delete` | an explicit `policy.public()` decides it (inside `any`, or inside `all` together only with branches that can pass without a user) | `TO authenticated` |

`auth.uid()` and `auth.jwt()` are always emitted as `(SELECT auth.uid())` / `(SELECT auth.jwt())` so Postgres evaluates them once per query (initPlan), not once per row.

## Summary

| Builder | Rule `kind` | SQL predicate |
| --- | --- | --- |
| [`isAuthenticated()`](#isauthenticated) | `authenticated` | `(SELECT auth.uid()) IS NOT NULL` |
| [`public()`](#public) | `public` | `TRUE` |
| [`none()`](#none) | `none` | `FALSE` |
| [`isOwner(column)`](#isowner) | `owner` | `(SELECT auth.uid()) = <column>` |
| [`hasRole(role)`](#hasrole) | `role` | `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = '<role>'` |
| [`belongsTo(column, through?)`](#belongsto) | `belongs_to` | `(SELECT <prefix>_<table>_belongs_to_<n>_fn(<column>))` |
| [`matchesField(a, b)`](#matchesfield) | `matches_field` | `<a> = <b>` |
| [`custom(expression, adapter?)`](#custom) | `custom` | `<expression>` verbatim |
| [`any(rules)`](#any) | `any` | `(<r1>) OR (<r2>) ...` |
| [`all(rules)`](#all) | `all` | `(<r1>) AND (<r2>) ...` |
| [`withCheck(using, check, options?)`](#withcheck) | `with_check` | `USING (<using>)`, `WITH CHECK ((<using>) AND (<check>))` |

## isAuthenticated

Any signed-in user.

```ts
isAuthenticated(): AuthenticatedRule; // { kind: 'authenticated' }
```

SQL: `(SELECT auth.uid()) IS NOT NULL`. Role: `authenticated`.

```ts
import { policy } from 'accessnexus';

export const policies = { select: policy.isAuthenticated() };
```

::: warning
On Supabase anyone can sign up. Do not use `isAuthenticated()` for `select` on a table with private columns (email, phone, address), and do not use it for `insert` on a table keyed by the user id (`validate` warns `USER_ROW_INSERT_OPEN`).
:::

## public

Everyone, including anonymous visitors.

```ts
public(): PublicRule; // { kind: 'public' }
```

SQL: `TRUE`. Role: `public`.

```ts
import { policy } from 'accessnexus';

export const policies = { select: policy.public() };
```

::: warning
On `insert`, `update` or `delete` this lets anyone holding your public anon key write the table. `validate` warns `PUBLIC_WRITE`.
:::

## none

Nobody through the API. The service role, `SECURITY DEFINER` functions and triggers still bypass RLS.

```ts
none(): NoneRule; // { kind: 'none' }
```

SQL: `FALSE`. Role: `authenticated`.

```ts
import { policy } from 'accessnexus';

export const policies = { update: policy.none(), delete: policy.none() };
```

## isOwner

The row belongs to the current user.

```ts
isOwner(column: string): OwnerRule; // { kind: 'owner', column }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `column` | `string` | Column holding the owner's user id. Must be `uuid` (`OWNER_COLUMN_NOT_UUID`). |

SQL: `(SELECT auth.uid()) = <column>`. Role: `authenticated`. The column is indexed automatically (`idx_<table>_<column>_rls`).

```ts
import { policy } from 'accessnexus';

export const policies = {
  select: policy.isOwner('user_id'),
  insert: policy.isOwner('user_id'),
  update: policy.isOwner('user_id'),
  delete: policy.isOwner('user_id'),
};
```

## hasRole

The user's global app role, read from the JWT `app_metadata.role` claim.

```ts
hasRole(role: string): RoleRule; // { kind: 'role', role }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `role` | `string` | Expected `app_metadata.role` value. Quoted as a SQL literal. |

SQL: `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = '<role>'`. Role: `authenticated`.

`app_metadata` is writable only server-side, e.g. `supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })` with the service role, or a custom access token hook. The top-level JWT `role` claim (the Postgres role, `anon` / `authenticated`) is not used.

```ts
import { policy } from 'accessnexus';

// Platform staff read the audit trail
export const policies = { select: policy.hasRole('admin') };
```

::: warning
`hasRole` is not a role inside an org or team. For tenant roles use `{ scope: 'tenant', roles: [...] }` in [definePermissions](/api/permissions) or `belongsTo(..., { where: { role: [...] } })`. `validate` warns `GLOBAL_ROLE_IN_TENANT_TABLE` when a table mixes `hasRole` with membership checks.
:::

## belongsTo

The current user is a member of the row's group (org, team, shop).

```ts
belongsTo(
  column: string,
  through?: {
    table: string;
    foreignKey: string;
    localKey: string;
    where?: Record<string, string | string[]>;
  },
): BelongsToRule; // { kind: 'belongs_to', column, through }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `column` | `string` | Column on this table holding the group id. Must be `uuid` (the helper takes `p_value uuid`). |
| `through.table` | `string` | Membership table, e.g. `'org_members'`. |
| `through.foreignKey` | `string` | Membership column holding the group id. |
| `through.localKey` | `string` | Membership column holding the user id. |
| `through.where` | `Record<string, string \| string[]>` | Extra filters on the membership row. An array becomes `IN (...)`, a string `= '...'`. Values are quoted literals. |

Each distinct `belongsTo` on a table compiles to a `SECURITY DEFINER` helper (one per signature, numbered from 1), which avoids RLS recursion even on the membership table itself:

```sql
CREATE OR REPLACE FUNCTION accessnexus_posts_belongs_to_1_fn(p_value uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_value AND user_id = (SELECT auth.uid()) AND role IN ('admin'));
$$;
REVOKE EXECUTE ON FUNCTION accessnexus_posts_belongs_to_1_fn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION accessnexus_posts_belongs_to_1_fn(uuid) TO authenticated;
```

The policy predicate is `(SELECT accessnexus_posts_belongs_to_1_fn(org_id))`. When a policy using the helper is granted `TO public`, the helper is also granted to `anon` (it returns false without a user).

Without `through`, the helper checks `profiles.<column>` of the current user: `SELECT EXISTS (SELECT 1 FROM public.profiles WHERE <column> = p_value AND id = (SELECT auth.uid()))`.

```ts
import { policy } from 'accessnexus';

const members = { table: 'org_members', foreignKey: 'org_id', localKey: 'user_id' };

export const policies = {
  select: policy.belongsTo('org_id', members),
  delete: policy.belongsTo('org_id', { ...members, where: { role: ['admin'] } }),
};
```

::: warning
`belongsTo(column)` without `through` trusts `profiles.<column>`. If users can insert their profile row or update that column, they can set it to any tenant id and join that tenant. `validate` rejects this (`BELONGS_TO_PROFILE_WRITABLE`). Prefer `through`; to keep the profiles lookup, use `insert: policy.none()` on profiles and `trigger.lockColumns({ columns: [column] })`.
:::

`validate` checks that `column`, `foreignKey`, `localKey` and `where` columns exist, and that `where` values belong to an enum column's values (`INVALID_ENUM_VALUE`).

## matchesField

Two values must be equal.

```ts
matchesField(fieldA: string, fieldB: string): MatchesFieldRule; // { kind: 'matches_field', fieldA, fieldB }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `fieldA` | `string` | Column name or an auth call such as `'auth.uid()'`. |
| `fieldB` | `string` | Column name or an auth call. |

SQL: `<fieldA> = <fieldB>`. A bare `auth.<fn>(...)` side is wrapped as `(SELECT auth.<fn>(...))`. Role for `select`: `public` when neither side contains `auth.`, else `authenticated`. Plain column names are checked by `validate` and indexed.

```ts
import { policy } from 'accessnexus';

export const policies = { insert: policy.matchesField('author_id', 'auth.uid()') };
// author_id = (SELECT auth.uid())
```

## custom

Raw SQL predicate, emitted verbatim.

```ts
custom(expression: string, adapter?: string): CustomRule; // { kind: 'custom', expression, adapter }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `expression` | `string` | SQL boolean expression evaluated per row. Must be non-empty (`INVALID_POLICY_RULE`). |
| `adapter` | `string` | Optional adapter hint. Stored on the rule; the Supabase adapter ignores it. |

Role for `select`: `public` (AccessNexus cannot tell whether the expression needs a user).

```ts
import { policy } from 'accessnexus';

export const policies = { select: policy.custom("status = 'published' AND deleted_at IS NULL") };
```

::: warning
The expression is not quoted or validated as SQL. Never interpolate user input into it. Write `(SELECT auth.uid())`, never a bare `auth.uid()` (`UNWRAPPED_AUTH_CALL` warning). Do not re-implement membership checks with subqueries on the same table; use `belongsTo` (RLS recursion).
:::

## any

OR: passes when any rule passes.

```ts
any(rules: PolicyRule[]): AnyRule; // { kind: 'any', rules }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `rules` | `PolicyRule[]` | At least one rule (`EMPTY_COMBINATOR`). |

SQL: each rule in parentheses, joined by `OR`; a single rule is emitted without wrapping.

```ts
import { policy } from 'accessnexus';

export const policies = {
  select: policy.any([policy.isOwner('author_id'), policy.custom("status = 'published'")]),
};
```

## all

AND: passes only when every rule passes.

```ts
all(rules: PolicyRule[]): AllRule; // { kind: 'all', rules }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `rules` | `PolicyRule[]` | At least one rule (`EMPTY_COMBINATOR`). |

SQL: each rule in parentheses, joined by `AND`.

Not to be confused with the `all` key of a table's `policies` (`policies: { all: rule }`), which applies one rule to every operation. See [Policies](/guide/policies#one-rule-for-every-operation-all).

```ts
import { policy } from 'accessnexus';

export const policies = {
  update: policy.all([policy.isOwner('user_id'), policy.custom('locked = false')]),
};
```

## withCheck

Separate rules for the rows a user may target (`USING`) and the row being written (`WITH CHECK`).

```ts
withCheck(
  using: PolicyRule,
  check: PolicyRule,
  options?: { mode?: WithCheckMode },
): WithCheckRule; // { kind: 'with_check', using, check, mode? }

type WithCheckMode = 'and' | 'replace';
```

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `using` | `PolicyRule` | required | Which existing rows the user may target. Also required of the new row unless `mode: 'replace'`. |
| `check` | `PolicyRule` | required | Condition on the written row. |
| `options.mode` | `'and' \| 'replace'` | `'and'` | `'and'`: `WITH CHECK ((<using>) AND (<check>))`. `'replace'`: `WITH CHECK (<check>)`. |

| Operation | `USING` | `WITH CHECK` (`'and'`) | `WITH CHECK` (`'replace'`) |
| --- | --- | --- | --- |
| `select`, `delete` | `using` | none | none |
| `insert` | none | `(using) AND (check)` | `check` |
| `update` | `using` | `(using) AND (check)` | `check` |

The `mode` key is only present on the rule when passed. Nested `withCheck` inside `any` / `all` contributes its `using` to `USING` and its check expression to `WITH CHECK`.

```ts
import { policy } from 'accessnexus';

export const policies = {
  // Authors edit their comments; every edit must set edited = true
  update: policy.withCheck(policy.isOwner('author_id'), policy.custom('edited = true')),
};

// The written row may leave the `using` condition (publishing a draft)
export const publishDraft = policy.withCheck(
  policy.all([policy.isOwner('author_id'), policy.custom("status = 'draft'")]),
  policy.all([policy.isOwner('author_id'), policy.custom("status IN ('draft', 'published')")]),
  { mode: 'replace' },
);
```

::: warning
`mode: 'replace'` drops `using` from `WITH CHECK`: an UPDATE may then move a row out of the user's ownership or tenant unless `check` repeats that condition. Keep the default unless the new row must legitimately leave `using`, and restate the ownership condition in `check`.
:::

## Types

| Type | Shape |
| --- | --- |
| `PolicyOperation` | `'select' \| 'insert' \| 'update' \| 'delete'` |
| `PolicyRule` | `{ readonly kind: string }` (base of every rule) |
| `TablePolicies` | `{ [op in PolicyOperation]?: PolicyRule }` |
| `WithCheckMode` | `'and' \| 'replace'` |

The concrete rule interfaces (`AuthenticatedRule`, `OwnerRule`, `BelongsToRule`, ...) are the return types shown above; only `PolicyRule`, `PolicyOperation`, `TablePolicies` and `WithCheckMode` are exported from `accessnexus`.
