# trigger

Builders for a table's `triggers` array. Each one compiles to a PL/pgSQL function plus a `CREATE TRIGGER`, written to `<table>_triggers.sql`. Guide: [Triggers](/guide/triggers).

```ts
import { trigger } from 'accessnexus';
```

## Common output

| Item | Value |
| --- | --- |
| Function name | `<prefix>_<table>_<suffix>_fn` |
| Trigger name | `<prefix>_<table>_<suffix>` |
| `search_path` | every function has `SET search_path = pg_catalog, <schemaName>` (default `public`) |
| Idempotency | `CREATE OR REPLACE FUNCTION`, and `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` (unless `adapterOptions.idempotent` is `false`) |
| Granularity | `FOR EACH ROW` (only `trigger.custom` can choose `statement`) |

`<prefix>` is the policy prefix (default `accessnexus`). Two triggers with the same suffix on one table would replace each other; `validate` reports `DUPLICATE_TRIGGER`.

| Builder | Suffix | Fires | Security |
| --- | --- | --- | --- |
| [`updatedAt`](#updatedat) | `updated_at` | `BEFORE UPDATE` | invoker |
| [`softDelete`](#softdelete) | `soft_delete`, `soft_delete_guard` | `BEFORE DELETE`, `BEFORE UPDATE OF <column>` | definer (delete), invoker (guard) |
| [`auditLog`](#auditlog) | `audit_log` | `AFTER INSERT OR UPDATE OR DELETE` | definer |
| [`lockColumns`](#lockcolumns) | `name` or `lock_columns` | `BEFORE UPDATE` | invoker |
| [`custom`](#custom) | `name` | `events` | `security` (default invoker) |
| [`keepAtLeastOne`](#keepatleastone) | `name` or `keep_<column>_<value>` | `BEFORE UPDATE OR DELETE` | definer |
| [`sameTenant`](#sametenant) | `name` or `same_tenant_<column>` | `BEFORE INSERT OR UPDATE` | invoker |
| [`memberOfTenant`](#memberoftenant) | `name` or `member_of_tenant_<column>` | `BEFORE INSERT OR UPDATE` | invoker |
| [`onAuthUserCreated`](#onauthusercreated) | `name` or `on_auth_user_created` | `AFTER INSERT ON auth.users` | definer |

## updatedAt

Set a timestamp column on every UPDATE.

```ts
updatedAt(column: string): UpdatedAtTrigger; // { kind: 'updated_at', column }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `column` | `string` | Timestamp column, usually `'timestamptz?'`. |

Body: `NEW.<column> = NOW(); RETURN NEW;`. `trigger.lockColumns` never blocks a column maintained by `updatedAt`.

```ts
import { table, trigger } from 'accessnexus';

export const posts = table({
  columns: { id: 'uuid', title: 'text', updated_at: 'timestamptz?' },
  primaryKey: 'id',
  triggers: [trigger.updatedAt('updated_at')],
});
```

## softDelete

Turn DELETE into `SET <column> = NOW()`.

```ts
softDelete(column: string): SoftDeleteTrigger; // { kind: 'soft_delete', column }
```

| Parameter | Type | Description |
| --- | --- | --- |
| `column` | `string` | Nullable timestamp column, e.g. `'deleted_at'`. |

Setting `softDelete: '<column>'` on the table adds this trigger automatically (and makes the SDK filter deleted rows); adding both is reported as `DUPLICATE_TRIGGER`.

Generated:

1. `<prefix>_<table>_soft_delete_fn`, `SECURITY DEFINER`, `BEFORE DELETE`: `UPDATE <schema>.<table> SET <column> = NOW() WHERE <pk> = OLD.<pk>; RETURN NULL;` (cancels the delete). `<pk>` is `primaryKey`, or `id`.
2. `<prefix>_<table>_soft_delete_guard_fn`, invoker, `BEFORE UPDATE OF <column>`: raises SQLSTATE `42501` when an API user (`anon` / `authenticated`) changes the column with a plain UPDATE.

The DELETE policy therefore decides who may soft-delete; the UPDATE policy cannot be used to soft-delete or restore. Restore rows with the service role or a `security: 'definer'` RPC.

::: warning
Soft-deleted rows stay visible through RLS; only the SDK filters them. To hide them from raw API reads, add the condition to `select`, e.g. `policy.all([policy.isOwner('author_id'), policy.custom('deleted_at IS NULL')])`. `onDelete: 'cascade'` into a soft-delete table is rejected (`CASCADE_INTO_SOFT_DELETE`).
:::

## auditLog

Record every INSERT, UPDATE and DELETE in an audit table.

```ts
auditLog(options: { table: string; columns?: string[] }): AuditLogTrigger;
// { kind: 'audit_log', table, columns }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `table` | `string` | required | Audit table in the schema. Qualified with the schema name unless it contains a dot. |
| `columns` | `string[]` | all columns | Log only these columns (`JSONB_BUILD_OBJECT`) instead of the whole row (`TO_JSONB`). |

The function is `SECURITY DEFINER` and runs:

```sql
INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
VALUES (TG_TABLE_NAME, TG_OP,
  CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
  NOW());
RETURN COALESCE(NEW, OLD);
```

The audit table must have `table_name`, `operation`, `old_data`, `new_data`, `changed_at`, and every other column must be nullable or have a default (`AUDIT_TABLE_MISMATCH`). Keep its `insert` policy `policy.none()`: the trigger does not need it, and an open insert lets users forge entries (`AUDIT_INSERT_OPEN`).

```ts
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  audit_log: table({
    columns: {
      id: 'uuid',
      table_name: 'text',
      operation: 'text',
      old_data: 'jsonb?',
      new_data: 'jsonb?',
      changed_at: { type: 'timestamptz', default: 'now()' },
    },
    primaryKey: 'id',
    policies: { select: policy.hasRole('admin'), insert: policy.none(), update: policy.none(), delete: policy.none() },
  }),
  invoices: table({
    columns: { id: 'uuid', owner_id: 'uuid', status: 'text' },
    primaryKey: 'id',
    triggers: [trigger.auditLog({ table: 'audit_log', columns: ['status'] })],
    policies: { select: policy.isOwner('owner_id'), update: policy.isOwner('owner_id') },
  }),
});
```

## lockColumns

Stop API users from changing some columns with UPDATE. RLS decides which rows a user may update, never which columns.

```ts
lockColumns(options: {
  columns?: string[];
  except?: string[];
  unless?: string;
  name?: string;
}): LockColumnsTrigger; // { kind: 'lock_columns', ...only the options passed }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `string[]` | `undefined` | Columns that may not change. Use this or `except`, not both (`INVALID_TRIGGER`). |
| `except` | `string[]` | `undefined` | Lock every column except these. |
| `unless` | `string` | `undefined` | Raw SQL condition (`NEW` and `OLD` available) under which the change is allowed. A `NULL` result counts as false. |
| `name` | `string` | `'lock_columns'` | Trigger suffix, lowercase snake_case. Required to be distinct when a table has two `lockColumns` triggers. |

The `BEFORE UPDATE` function raises SQLSTATE `42501` once per column that changed, when all of these hold:

- `current_user IN ('anon', 'authenticated')` — the service role and `SECURITY DEFINER` code are never blocked;
- `unless` is not true;
- a locked column changed. With `columns`: `NEW.c IS DISTINCT FROM OLD.c` for each. With `except`: the first key (in key order) of `to_jsonb(NEW) - ARRAY[...]` whose value differs from `to_jsonb(OLD)`, found with `jsonb_each`.

The error names the column and carries a stable HINT:

| Field | Value |
| --- | --- |
| Message | `<table>.<column> cannot be changed` |
| SQLSTATE | `42501` (the same as an RLS denial) |
| HINT | `accessnexus:locked_column:<table>.<column>` |

The HINT is what tells a locked column from an RLS denial: the generated SDK's [`isLockedColumn(error)`](/api/sdk#helpers) checks it.

Columns kept by `trigger.updatedAt` on the same table are always allowed to change.

Generated SQL for `columns: ['reporter_id', 'org_id']` on `tasks`:

```sql
CREATE OR REPLACE FUNCTION accessnexus_tasks_lock_identity_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NEW.reporter_id IS DISTINCT FROM OLD.reporter_id THEN
      RAISE EXCEPTION '%', 'tasks.' || 'reporter_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || 'reporter_id';
    END IF;
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
      RAISE EXCEPTION '%', 'tasks.' || 'org_id' || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || 'org_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
```

With `except: ['status']` the function finds the changed key instead of listing columns:

```sql
DECLARE
  locked_column text;
BEGIN
  IF current_user IN ('anon', 'authenticated') AND NOT COALESCE((<unless>), FALSE) THEN
    SELECT n.key INTO locked_column
      FROM jsonb_each(to_jsonb(NEW) - ARRAY['status', 'updated_at']::text[]) AS n
     WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
     ORDER BY n.key LIMIT 1;
    IF locked_column IS NOT NULL THEN
      RAISE EXCEPTION '%', 'tasks.' || locked_column || ' cannot be changed'
        USING ERRCODE = '42501', HINT = 'accessnexus:locked_column:tasks.' || locked_column;
    END IF;
  END IF;
  RETURN NEW;
END;
```

```ts
import { table, trigger } from 'accessnexus';

export const tasks = table({
  columns: { id: 'uuid', org_id: 'uuid', reporter_id: 'uuid', status: 'text', title: 'text' },
  primaryKey: 'id',
  triggers: [
    trigger.lockColumns({ name: 'lock_identity', columns: ['reporter_id', 'org_id'] }),
    trigger.lockColumns({
      except: ['status'],
      unless: "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = NEW.org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin')",
    }),
  ],
});
```

::: warning
`unless` is raw SQL run as the calling user. Write `(SELECT auth.uid())`, not a bare `auth.uid()` (`UNWRAPPED_AUTH_CALL`), and never interpolate untrusted input.
:::

## custom

A trigger with your own PL/pgSQL body.

```ts
custom(options: {
  name: string;
  events: TriggerEvent[];
  functionBody: string;
  when?: string;
  forEach?: TriggerForEach;
  security?: 'invoker' | 'definer';
  set?: Record<string, string>;
  writes?: string[];
}): CustomTrigger;

type TriggerEvent =
  | 'before_insert' | 'after_insert'
  | 'before_update' | 'after_update'
  | 'before_delete' | 'after_delete';
type TriggerForEach = 'row' | 'statement';
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | required | Trigger suffix, lowercase snake_case (`INVALID_IDENTIFIER`). |
| `events` | `TriggerEvent[]` | required | At least one (`INVALID_TRIGGER`). |
| `functionBody` | `string` | required | PL/pgSQL statements placed between `BEGIN` and `END;`. Must end with `RETURN NEW`, `RETURN OLD` or `RETURN NULL`. |
| `when` | `string` | `undefined` | SQL condition emitted as `WHEN (<when>)`. |
| `forEach` | `'row' \| 'statement'` | `'row'` | `FOR EACH ROW` or `FOR EACH STATEMENT`. |
| `security` | `'invoker' \| 'definer'` | `'invoker'` | `'definer'` adds `SECURITY DEFINER`: the body runs as the function owner and bypasses RLS. |
| `set` | `Record<string, string>` | `undefined` | Function configuration, as in [`rpc`](/api/rpc#options): `{ row_security: 'off' }` emits `SET row_security = 'off'`. `search_path` stays pinned to `pg_catalog, public`. |
| `writes` | `string[]` | `undefined` | Other tables the function writes, e.g. `['team_members']`. Only the SDK uses it: with `reactQuery: true`, a mutation on this table then also invalidates those tables' queries (`teams.create()` refreshes `team_members`). It changes no SQL. |

Events are grouped by timing: `['before_insert', 'before_update']` becomes `BEFORE INSERT OR UPDATE`. The body is wrapped as `BEGIN <functionBody> END;`, so it cannot have its own `DECLARE` section.

::: warning
Use events of a single timing in one trigger. Mixing `before_*` and `after_*` produces `BEFORE ... OR AFTER ...`, which Postgres rejects at `push`; `validate` does not catch it. Split them into two triggers.
:::

```ts
import { trigger } from 'accessnexus';

export const lowerEmail = trigger.custom({
  name: 'lowercase_email',
  events: ['before_insert', 'before_update'],
  when: 'NEW.email IS NOT NULL',
  functionBody: 'NEW.email = lower(NEW.email); RETURN NEW;',
});

// Trusted side effect: add the creator as the first owner
export const addCreator = trigger.custom({
  name: 'add_creator_as_owner',
  events: ['after_insert'],
  security: 'definer',
  functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
  writes: ['team_members'], // React Query: teams.create() also refreshes team_members
});
```

::: warning
`security: 'definer'` bypasses RLS for everything the body reads and writes. Use it only for trusted side effects, schema-qualify tables (`public.team_members`), and check the caller inside the body when it matters.
:::

## keepAtLeastOne

Keep at least one row with `column = value` per `scope`: an org always has an owner. The last such row cannot be deleted, and cannot be changed to another value.

```ts
keepAtLeastOne(options: {
  column: string;
  value: string;
  scope: string;
  parent?: string;
  name?: string;
}): KeepAtLeastOneTrigger; // { kind: 'keep_at_least_one', ...options }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `column` | `string` | required | Column that holds the protected value, e.g. `'role'`. |
| `value` | `string` | required | The protected value, e.g. `'owner'`. |
| `scope` | `string` | required | Column that groups the rows, e.g. `'team_id'`: each scope needs one. |
| `parent` | `string` | `undefined` | `'<table>.<column>'` of the scope's parent, e.g. `'teams.id'`. When the parent row is gone (a cascade delete), the guard steps aside, so deleting the team still works. |
| `name` | `string` | `keep_<column>_<value>` | Trigger suffix, lowercase snake_case. |

The table needs a single `primaryKey` (`INVALID_TRIGGER` otherwise). The function is `SECURITY DEFINER` (it must see every row of the scope, whatever the caller's RLS shows) and fires `BEFORE UPDATE OR DELETE`. It acts when the old row has `column = value` and the operation is a DELETE, or changes `column` or `scope`. It then locks the scope's rows with `SELECT ... FOR UPDATE`, so two concurrent demotions cannot both pass, and raises SQLSTATE `23514` when no other row with the value remains:

```sql
PERFORM 1 FROM public.team_members m WHERE m.team_id = OLD.team_id AND m.role = 'owner' FOR UPDATE;
IF NOT EXISTS (
  SELECT 1 FROM public.team_members m
  WHERE m.team_id = OLD.team_id AND m.role = 'owner' AND m.id <> OLD.id
) THEN
  RAISE EXCEPTION 'team_members: each team_id needs at least one role = owner'
    USING ERRCODE = '23514';
END IF;
```

With `parent`, the condition also requires `EXISTS (SELECT 1 FROM public.teams p WHERE p.id = OLD.team_id)`.

```ts
import { trigger } from 'accessnexus';

// The last owner of a team cannot leave or be demoted; deleting the team still cascades.
export const keepOwner = trigger.keepAtLeastOne({ column: 'role', value: 'owner', scope: 'team_id', parent: 'teams.id' });
```

## sameTenant

`column` must reference a row of the same tenant. Foreign keys are checked without RLS, so without this a member of tenant A could create a row in A that points at tenant B's row (probing its ids, attaching rows that cascade with B's data). `validate` warns `TENANT_PARENT_UNCHECKED` when the guard is missing.

```ts
sameTenant(options: {
  column: string;
  references: string;
  tenantColumn: string;
  referencesTenantColumn?: string;
  name?: string;
}): SameTenantTrigger; // { kind: 'same_tenant', ...options }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `column` | `string` | required | Foreign key column of this table, e.g. `'project_id'`. |
| `references` | `string` | required | Table the column points to, e.g. `'projects'` (matched on its primary key, or `id`). |
| `tenantColumn` | `string` | required | This table's tenant column, e.g. `'org_id'`. Also the parent's tenant column unless `referencesTenantColumn` is set. |
| `referencesTenantColumn` | `string` | `tenantColumn` | The parent's tenant column, when it has another name. |
| `name` | `string` | `same_tenant_<column>` | Trigger suffix, lowercase snake_case. |

The function is `SECURITY INVOKER` and fires `BEFORE INSERT OR UPDATE`. It runs as the writer: a parent row the user cannot see counts as missing, so the check never reveals another tenant's ids. A `NULL` column is allowed. Otherwise a parent that is missing, or in another tenant, raises SQLSTATE `23503`:

```sql
IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
  RAISE EXCEPTION '%', 'tasks.project_id ' || NEW.project_id || ' is not in org_id ' || NEW.org_id
    USING ERRCODE = '23503';
END IF;
```

```ts
import { trigger } from 'accessnexus';

// tasks.project_id must be a project of the same org (NULL allowed)
export const sameOrg = trigger.sameTenant({ column: 'project_id', references: 'projects', tenantColumn: 'org_id' });
```

Pair it with `trigger.lockColumns` on `org_id` and `project_id`, so a later UPDATE cannot move the row. Full example: [Child of a tenant resource](/guide/cookbook#child-of-a-tenant-resource).

## memberOfTenant

`column` (a user id) must be a member of the row's tenant: an assignee, a reviewer.

```ts
memberOfTenant(options: {
  column: string;
  tenant: { table: string; userColumn: string; tenantColumn: string };
  tenantColumn?: string;
  name?: string;
}): MemberOfTenantTrigger; // { kind: 'member_of_tenant', ...options }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `column` | `string` | required | Column that holds the user id, e.g. `'assignee_id'`. |
| `tenant` | `{ table, userColumn, tenantColumn }` | required | The membership table, as in [`definePermissions`](/api/permissions). |
| `tenantColumn` | `string` | `tenant.tenantColumn` | The row's own tenant column, when it has another name than the membership table's. |
| `name` | `string` | `member_of_tenant_<column>` | Trigger suffix, lowercase snake_case. |

Like `sameTenant` it is `SECURITY INVOKER`, fires `BEFORE INSERT OR UPDATE`, runs as the writer, allows `NULL` and raises SQLSTATE `23503`:

```sql
IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.team_members m WHERE m.user_id = NEW.assignee_id AND m.team_id = NEW.team_id) THEN
  RAISE EXCEPTION '%', 'tasks.assignee_id ' || NEW.assignee_id || ' is not a member of team_id ' || NEW.team_id
    USING ERRCODE = '23503';
END IF;
```

```ts
import { trigger } from 'accessnexus';

// assignee_id must be a member of the row's team (NULL allowed)
export const assigneeIsMember = trigger.memberOfTenant({
  column: 'assignee_id',
  tenant: { table: 'team_members', userColumn: 'user_id', tenantColumn: 'team_id' },
});
```

## onAuthUserCreated

Insert a row of this table whenever a user signs up, so the client never needs an "ensure profile" step.

```ts
onAuthUserCreated(options: {
  columns: Record<string, string>;
  name?: string;
}): OnAuthUserCreatedTrigger; // { kind: 'on_auth_user_created', ...options }
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `Record<string, string>` | required | Column of this table to an SQL expression over `NEW` (the `auth.users` row), e.g. `{ id: 'NEW.id', display_name: "split_part(NEW.email, '@', 1)" }`. Each expression must be non-empty SQL (`INVALID_TRIGGER`). |
| `name` | `string` | `on_auth_user_created` | Trigger suffix, lowercase snake_case. |

The trigger lives on `auth.users`, not on the table. The function is `SECURITY DEFINER`, its `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated`, and the insert uses `ON CONFLICT DO NOTHING`, so a row that already exists never blocks sign-up:

```sql
CREATE OR REPLACE FUNCTION accessnexus_profiles_on_auth_user_created_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, split_part(NEW.email, '@', 1))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
REVOKE EXECUTE ON FUNCTION accessnexus_profiles_on_auth_user_created_fn() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS accessnexus_profiles_on_auth_user_created ON auth.users;
CREATE TRIGGER accessnexus_profiles_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_profiles_on_auth_user_created_fn();
```

```ts
import { trigger } from 'accessnexus';

// On the profiles table: a row per new auth user
export const profileOnSignUp = trigger.onAuthUserCreated({
  columns: { id: 'NEW.id', display_name: "split_part(NEW.email, '@', 1)" },
});
```

::: warning
Removing the builder from the schema does not drop the trigger on `auth.users`; drop it by hand.
:::

## Types

Exported from `accessnexus`: `TriggerRule` (`{ readonly kind: string }`), `TableTriggers` (`TriggerRule[]`), `TriggerEvent`, `TriggerForEach`, `UpdatedAtTrigger`, `SoftDeleteTrigger`, `AuditLogTrigger`, `LockColumnsTrigger`, `CustomTrigger`, `KeepAtLeastOneTrigger`, `SameTenantTrigger`, `MemberOfTenantTrigger`, `OnAuthUserCreatedTrigger`.
