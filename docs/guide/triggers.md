# Triggers

Triggers run logic inside Postgres when a row is written. AccessNexus ships presets for the common cases (timestamps, soft delete, audit log, column locks) and an escape hatch for custom PL/pgSQL. Put them in a table's `triggers` array; `generate` writes one `<table>_triggers.sql` per table with the functions and `CREATE TRIGGER` statements.

| Builder | Fires | Runs as |
| --- | --- | --- |
| `trigger.updatedAt(column)` | `BEFORE UPDATE` | The writing user |
| `trigger.softDelete(column)` | `BEFORE DELETE` | Function owner (`SECURITY DEFINER`) |
| `trigger.auditLog({ table, columns? })` | `AFTER INSERT OR UPDATE OR DELETE` | Function owner (`SECURITY DEFINER`) |
| `trigger.lockColumns({ columns \| except, unless?, name? })` | `BEFORE UPDATE` | The writing user |
| `trigger.custom({ name, events, functionBody, when?, forEach?, security? })` | Your events | The writing user, or the owner with `security: 'definer'` |

Every generated function has `SET search_path = pg_catalog, public`. Triggers are named `<prefix>_<table>_<name>` and their functions add `_fn`, e.g. `accessnexus_projects_updated_at` and `accessnexus_projects_updated_at_fn()`. The file replaces them in place on every push.

## Why triggers: RLS cannot restrict columns

RLS answers "may this user touch this row?". It cannot compare the old and new values of a column, so it cannot say "the assignee may change `status` but not `title`", or "nobody may change `owner_id` after creation". An `update: policy.isOwner('assignee_id')` rule lets the assignee rewrite every column of the row, including the owner and the tenant.

Triggers see both `OLD` and `NEW`, which is why column-level rules live here. Use [`trigger.lockColumns`](#trigger-lockcolumns) for them, never an extra UPDATE rule.

## `trigger.updatedAt`

Sets a timestamp column to `NOW()` on every UPDATE.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
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

```sql
CREATE OR REPLACE FUNCTION accessnexus_notes_updated_at_fn()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

CREATE TRIGGER accessnexus_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION accessnexus_notes_updated_at_fn();
```

## Soft delete

Prefer the table option `softDelete: 'deleted_at'` over adding `trigger.softDelete` yourself: the option adds the trigger and its guard, plus a partial index and the SDK filter that hides deleted rows (see [Schema](/guide/schema#soft-delete)). Listing `trigger.softDelete` as well is harmless; it is generated once.

```ts
import { trigger } from 'accessnexus';

// What the table option adds for you
export const softDelete = trigger.softDelete('deleted_at');
```

The generated SQL intercepts the DELETE, sets the column, and cancels the original delete by returning `NULL`:

```sql
CREATE OR REPLACE FUNCTION accessnexus_projects_soft_delete_fn()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.projects SET deleted_at = NOW() WHERE id = OLD.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
```

A guard trigger is generated with it. It rejects any plain UPDATE by an API user that sets or clears the column:

```sql
CREATE OR REPLACE FUNCTION accessnexus_projects_soft_delete_guard_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'projects.deleted_at can only be set by DELETE (soft delete)'
      USING ERRCODE = '42501',
      HINT = 'Delete the row instead; the DELETE policy decides who may. Restore rows with the service role or a security definer RPC.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
```

So the **DELETE policy** decides who may soft-delete, and the UPDATE policy cannot be used to delete or restore. The function is `SECURITY DEFINER` because the inner UPDATE must not depend on the user's UPDATE policy; its target is schema-qualified. Restore rows with the service role or a `security: 'definer'` RPC.

::: warning Soft-deleted rows stay visible through RLS
Only the SDK hides them. Add `policy.custom('deleted_at IS NULL')` to the `select` rule if raw API reads must not see them.
:::

## `trigger.auditLog`

Writes every INSERT, UPDATE and DELETE to an audit table as JSONB.

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

```sql
CREATE OR REPLACE FUNCTION accessnexus_invoices_audit_log_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.audit_log (table_name, operation, old_data, new_data, changed_at)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    NOW()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
```

### The audit table contract

| Column | Type | Value |
| --- | --- | --- |
| `table_name` | `text` | `TG_TABLE_NAME` |
| `operation` | `text` | `INSERT`, `UPDATE` or `DELETE` |
| `old_data` | `jsonb?` | The row before; `NULL` on INSERT |
| `new_data` | `jsonb?` | The row after; `NULL` on DELETE |
| `changed_at` | `timestamptz` | `NOW()` |

Any other column must be nullable or have a default (a `bigint` primary key is an identity). A mismatch fails `validate` with `AUDIT_TABLE_MISMATCH`. One audit table can serve many tables.

`columns: ['status', 'amount']` logs only those columns: the trigger stores `JSONB_BUILD_OBJECT('status', OLD.status, ...)` instead of the whole row. Use it to keep sensitive columns out of the log.

::: danger Keep API inserts closed on the audit table
The trigger function is `SECURITY DEFINER`, so it writes even when the audit table's `insert` is `policy.none()`. Keep it that way: if users can insert, they can forge entries. `validate` warns `AUDIT_INSERT_OPEN`.
:::

## `trigger.lockColumns`

Stops API users (`anon`, `authenticated`) from changing columns with UPDATE. It fires `BEFORE UPDATE`, compares `OLD` and `NEW`, and raises SQLSTATE `42501` when a locked column changes.

| Option | Description |
| --- | --- |
| `columns` | Columns that may not change. Use this **or** `except` |
| `except` | Lock every column except these |
| `unless` | Raw SQL condition (`OLD` and `NEW` available) under which the change is allowed |
| `name` | Trigger name suffix (default `lock_columns`). Required when a table has two `lockColumns` triggers (`DUPLICATE_TRIGGER` otherwise) |

It never blocks the service role, `SECURITY DEFINER` triggers and RPCs, or the column maintained by `trigger.updatedAt`.

### Freeze ownership and tenant columns

```ts
import { trigger } from 'accessnexus';

// Nobody re-attributes a project or moves it to another org
export const freezeIdentity = trigger.lockColumns({ columns: ['created_by', 'org_id'] });
```

```sql
CREATE OR REPLACE FUNCTION accessnexus_projects_lock_columns_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    RAISE EXCEPTION 'projects: created_by, org_id cannot be changed'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
```

Freeze owner, creator and tenant columns on every table where users may update rows. The UPDATE rule only checks that the new row still passes it: when the rule has several branches ("the owner OR an org admin"), an org admin may rewrite `created_by`, and someone who administers two orgs may move a row between them. The lock closes both.

### Let some users change only some columns

The assignee of a ticket may only change `status`; the reporter may change anything else:

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
      // Everyone except the reporter may change only status
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

The `except` form compares the whole row minus the allowed columns:

```sql
IF current_user IN ('anon', 'authenticated')
   AND NOT COALESCE((OLD.reporter_id = (SELECT auth.uid())), FALSE)
   AND ((to_jsonb(NEW) - ARRAY['status']::text[]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status']::text[])) THEN
  RAISE EXCEPTION 'tickets: only status can be changed'
    USING ERRCODE = '42501';
END IF;
```

`unless` is raw SQL run as the caller. Write `(SELECT auth.uid())`, never a bare `auth.uid()`. It may query the membership table directly, for example "the user is an org admin":

```ts
import { trigger } from 'accessnexus';

export const statusOnly = trigger.lockColumns({
  name: 'member_scope',
  except: ['status', 'position'],
  unless: "EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = OLD.org_id AND m.user_id = (SELECT auth.uid()) AND m.role = 'admin')",
});
```

This is the one place where an `EXISTS` on the membership table is the right tool: the condition runs outside any policy, so there is no recursion, and the membership table's own `select` policy still applies to it.

## `trigger.custom`

Full control over the PL/pgSQL body.

| Option | Description |
| --- | --- |
| `name` | Trigger name suffix, used in the function and trigger names |
| `events` | `before_insert`, `after_insert`, `before_update`, `after_update`, `before_delete`, `after_delete` |
| `functionBody` | PL/pgSQL body, without the `CREATE FUNCTION` wrapper. Return `NEW` (or `OLD` / `NULL`) yourself |
| `when` | Optional `WHEN` condition, e.g. `'NEW.email IS NOT NULL'` |
| `forEach` | `'row'` (default) or `'statement'` |
| `security` | `'invoker'` (default) or `'definer'` |

```ts
import { trigger } from 'accessnexus';

export const lowerEmail = trigger.custom({
  name: 'lowercase_email',
  events: ['before_insert', 'before_update'],
  when: 'NEW.email IS NOT NULL',
  functionBody: 'NEW.email = lower(NEW.email); RETURN NEW;',
});
```

Events with the same timing are combined into one trigger: `['before_insert', 'before_update']` becomes `BEFORE INSERT OR UPDATE`, and `when` becomes the trigger's `WHEN (...)` clause.

### `security: 'definer'`

By default a custom trigger runs as the writing user, and RLS applies to everything its body reads and writes. With `security: 'definer'` it runs as the function owner and **bypasses RLS**. Use it only for trusted side effects, such as adding the creator of a team as its first owner:

```ts
import { trigger } from 'accessnexus';

export const addCreator = trigger.custom({
  name: 'add_creator_as_owner',
  events: ['after_insert'],
  security: 'definer',
  functionBody: "INSERT INTO public.team_members (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner'); RETURN NEW;",
});
```

::: danger Definer bodies trust nothing but the row
A definer body skips every policy, so it must decide what is allowed from `NEW`, `OLD` and `(SELECT auth.uid())` alone. Schema-qualify every table (`public.team_members`). Prefer this over a "bootstrap" INSERT rule on the membership table ("the creator may add themselves as owner"), which stays valid forever and lets a removed creator rejoin.
:::

An invoker trigger is the right choice for guards that should respect RLS. For example, a `BEFORE INSERT OR UPDATE` trigger that checks a task's project belongs to the same org: a project of another org is invisible through RLS, so it is reported like a project that does not exist. The full pattern is in the [Cookbook](/guide/cookbook).

## Next steps

- [Policies](/guide/policies) - row-level rules that triggers complement
- [Permissions](/guide/permissions) - multi-tenant walkthrough using `lockColumns` and a definer trigger
- [Cookbook](/guide/cookbook) - same-tenant guards and column-scoped updates
- [Trigger API](/api/trigger) - full signatures and types
