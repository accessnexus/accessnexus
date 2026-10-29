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

The `BEFORE UPDATE` function raises SQLSTATE `42501` with `<table>: <cols> cannot be changed` (or `<table>: only <cols> can be changed`) when all of these hold:

- `current_user IN ('anon', 'authenticated')` — the service role and `SECURITY DEFINER` code are never blocked;
- `unless` is not true;
- a locked column changed. With `columns`: `NEW.c IS DISTINCT FROM OLD.c` for each. With `except`: `to_jsonb(NEW) - ARRAY[...]` differs from `to_jsonb(OLD) - ARRAY[...]`.

Columns kept by `trigger.updatedAt` on the same table are always allowed to change.

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
});
```

::: warning
`security: 'definer'` bypasses RLS for everything the body reads and writes. Use it only for trusted side effects, schema-qualify tables (`public.team_members`), and check the caller inside the body when it matters.
:::

## Types

Exported from `accessnexus`: `TriggerRule` (`{ readonly kind: string }`), `TableTriggers` (`TriggerRule[]`), `TriggerEvent`, `TriggerForEach`, `UpdatedAtTrigger`, `SoftDeleteTrigger`, `AuditLogTrigger`, `LockColumnsTrigger`, `CustomTrigger`.
