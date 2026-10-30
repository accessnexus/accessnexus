# Schema

`accessnexus.schema.ts` is the single source of truth for your database. It default-exports `defineSchema({...})`, a map of table names to table definitions. This page covers the shape of tables and columns; access rules are in [Policies](/guide/policies) and [Permissions](/guide/permissions).

There are two ways to define a schema:

- **Manual mode**: every table declares its `columns` with `table({...})`. AccessNexus generates the DDL migrations too.
- **Database mode**: columns come from the `Database` type Supabase generates. AccessNexus generates RLS, triggers, RPCs and the SDK, but no migrations.

The mode is detected automatically: Database mode when no table declares `columns`.

## A manual-mode table

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  posts: table({
    columns: {
      id: 'uuid',
      author_id: 'uuid',
      title: 'text',
      status: { type: "enum('draft','published')", default: "'draft'" },
      tags: 'text[]?',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { author_id: 'auth.users.id' },
    indexes: [{ columns: ['author_id', 'status'] }],
    softDelete: 'deleted_at',
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('author_id'),
      insert: policy.isOwner('author_id'),
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
});
```

Table and column names must be lowercase `snake_case` and cannot be reserved SQL keywords: `order`, `user`, `group`, `limit` are rejected (`RESERVED_IDENTIFIER`); use `orders`, `user_id`. Identifiers are emitted unquoted, which is why the rule is strict.

## Table options

| Option | Type | Description |
| --- | --- | --- |
| `columns` | `Record<string, ColumnInput>` | Required in manual mode. See [Columns](#columns) |
| `primaryKey` | column name | The primary key column |
| `compositePrimaryKey` | column names | A key over several columns, instead of `primaryKey` |
| `references` | `{ column: 'table.column' }` | Foreign keys. Use `'schema.table.column'` for other schemas, e.g. `'auth.users.id'` |
| `onDelete` | `{ column: action }` | `ON DELETE` per referencing column: `'cascade'`, `'set null'`, `'restrict'`, `'no action'` |
| `indexes` | `{ columns, unique?, name? }[]` | Extra indexes |
| `softDelete` | column name | DELETE sets this column to `NOW()` instead of removing the row |
| `policies` | `{ select?, insert?, update?, delete? }` | One rule per operation. See [Policies](/guide/policies) |
| `triggers` | `TriggerRule[]` | See [Triggers](/guide/triggers) |
| `enableRLS` | `boolean` | Only `false` matters: it turns RLS off. See [RLS is always on](#rls-is-always-on) |

## Columns

A column is a type string, or an object when it needs more than a type:

```ts
columns: {
  name: 'text',                                          // NOT NULL
  bio: 'text?',                                          // nullable
  score: { type: 'int', default: '0', check: 'score >= 0' },
  slug: { type: 'text', unique: true },
}
```

### Types

| Type | TypeScript type in the SDK |
| --- | --- |
| `uuid`, `text`, `varchar` | `string` |
| `date`, `timestamp`, `timestamptz`, `time` | `string` |
| `int`, `smallint`, `bigint`, `serial`, `float`, `decimal`, `numeric`, `numeric(p,s)` | `number` |
| `boolean` | `boolean` |
| `json`, `jsonb` | `Json` (same as Supabase's: `string \| number \| boolean \| null \| { [key: string]: Json \| undefined } \| Json[]`) |
| `text[]`, `uuid[]` | `string[]` |
| `int[]` | `number[]` |
| `"enum('a','b')"` | `string` |

Append `?` to any type to make it nullable: `'text?'`, `'uuid[]?'`, `"enum('a','b')?"`. Without `?` the column is `NOT NULL`.

### Column object

| Field | Description |
| --- | --- |
| `type` | Any type above, with or without `?` |
| `default` | Raw SQL default expression, emitted verbatim |
| `unique` | Adds a `UNIQUE` constraint |
| `check` | Raw SQL `CHECK` expression, e.g. `'amount >= 0'` |
| `references` | Foreign key target, same format as the table-level `references` |
| `onDelete` | `ON DELETE` action for this column's foreign key |

### Defaults are raw SQL

`default` and `check` are copied into the SQL as written. Functions, numbers and booleans work as plain strings: `'now()'`, `'0'`, `'false'`. A **string or enum literal needs its own single quotes** inside the JavaScript string:

```ts
status: { type: "enum('todo','done')", default: "'todo'" }  // DEFAULT 'todo'
```

::: warning
`default: 'todo'` would emit `DEFAULT todo`, which Postgres reads as a column name. `validate` reports it as `INVALID_DEFAULT`.
:::

### Enums

`"enum('todo','doing','done')"` creates a dedicated Postgres type named `<table>_<column>_enum`:

```sql
CREATE TYPE tasks_status_enum AS ENUM ('todo', 'doing', 'done');
```

Each enum column gets its own type, even when two columns list the same values. To compare them in SQL, cast through text: `v.role::text::org_members_role_enum`.

### Primary keys

| Primary key type | Generated |
| --- | --- |
| `uuid` | `DEFAULT gen_random_uuid()` |
| `bigint` | `GENERATED ALWAYS AS IDENTITY` |

For time-ordered UUIDs, set `adapterOptions.uuidGeneration: 'v7'` in `accessnexus.config.ts`: uuid primary keys then default to a generated `public.accessnexus_uuidv7()` helper. A table without `primaryKey` triggers the `NO_PRIMARY_KEY` warning; the SDK's `findById`, `update` and `delete` work by primary key.

## References and `onDelete`

Declare foreign keys at the table level or on the column:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

const ownerOnly = {
  select: policy.isOwner('owner_id'),
  insert: policy.isOwner('owner_id'),
  update: policy.isOwner('owner_id'),
  delete: policy.isOwner('owner_id'),
};

export default defineSchema({
  projects: table({
    columns: { id: 'uuid', owner_id: 'uuid', name: 'text' },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id' },
    policies: ownerOnly,
  }),
  tasks: table({
    columns: {
      id: 'uuid',
      owner_id: 'uuid',
      // column form: tasks go with their project
      project_id: { type: 'uuid', references: 'projects.id', onDelete: 'cascade' },
      assignee_id: 'uuid?',
    },
    primaryKey: 'id',
    references: { owner_id: 'auth.users.id', assignee_id: 'auth.users.id' },
    onDelete: { assignee_id: 'set null' }, // table form
    policies: ownerOnly,
  }),
});
```

| Action | Deleting a parent row with children |
| --- | --- |
| *(default)* `'no action'` | Fails with a foreign key error |
| `'restrict'` | Fails with a foreign key error |
| `'cascade'` | Deletes the children too |
| `'set null'` | Sets the child column to `NULL` (the column must be nullable) |

Foreign key columns get an index automatically (`idx_<table>_<column>_fk`) unless you declare a single-column index on them. `references` also powers the SDK's `include` option, which embeds related rows.

::: warning Cascades bypass RLS
A cascade runs as the table owner: RLS on the child table does not stop it. Only cascade where deleting the parent really should delete everything below it. `'cascade'` into a `softDelete` table is rejected (`CASCADE_INTO_SOFT_DELETE`), because the soft delete would leave children pointing at a deleted parent: use `'restrict'` and soft-delete the children first.
:::

## Indexes

```ts
indexes: [
  { columns: ['project_id', 'status'] },
  { columns: ['project_id', 'title'], unique: true, name: 'tasks_project_title_key' },
]
```

Without `name`, AccessNexus names the index after the table and columns, e.g. `idx_tasks_project_id_status_1`. Columns are checked by `validate` (`UNKNOWN_COLUMN`).

## Soft delete

`softDelete: 'deleted_at'` turns a DELETE into `UPDATE ... SET deleted_at = NOW()`. It adds:

- a `BEFORE DELETE` trigger that sets the column and cancels the delete;
- a guard trigger that rejects any plain UPDATE by an API user that sets or clears the column, so only DELETE (and its policy) can soft-delete a row;
- a partial index on the primary key `WHERE deleted_at IS NULL`;
- an automatic `deleted_at IS NULL` filter on SDK reads.

Use a nullable timestamp column (`'timestamptz?'`): `NULL` means live, a timestamp means deleted. The DELETE policy decides who may soft-delete; restore rows with the service role or a `security: 'definer'` RPC.

::: danger Soft-deleted rows are still visible through RLS
Only the SDK filters them. A raw API query (`supabase.from('posts').select()`) still returns them. To hide them from every client, put the condition in the `select` rule, for example `policy.all([policy.isOwner('author_id'), policy.custom('deleted_at IS NULL')])`.
:::

Details of the generated triggers are in [Triggers](/guide/triggers#soft-delete).

## RLS is always on

Every table gets `ENABLE` and `FORCE ROW LEVEL SECURITY`.

| Table definition | Result through the API |
| --- | --- |
| `policies` with a rule per operation | Each operation follows its rule |
| `policies` missing an operation | That operation is denied |
| No `policies` at all | Deny-all for `anon` and `authenticated`; only the service role and `SECURITY DEFINER` code reach it. `validate` warns `NO_POLICIES` |
| `enableRLS: false` | RLS off: anyone with the anon key can read and write. `validate` warns `RLS_DISABLED` |

A table without policies is the right choice for server-only data. For a table the client uses, add policies and block individual operations with `policy.none()`.

::: danger Never use `enableRLS: false` to fix a permission error
It opens the whole table to anyone who has your public anon key. Use it only for a table that is meant to be fully open, and only when someone asked for that.
:::

## Database mode

If your project already has a Supabase-generated `database.types.ts` (`supabase gen types typescript`), you can skip redeclaring columns. Pass the `Database` type to `defineSchema` and list only the tables you want to configure, without `columns`:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, rpc } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSchema<Database>({
  profiles: {
    primaryKey: 'id',
    policies: {
      // Each user reads only their own profile
      select: policy.isOwner('id'),
      update: policy.isOwner('id'),
    },
  },
}, {
  rpcs: { get_stats: rpc() },
});
```

A Database-mode table accepts `primaryKey`, `references`, `policies`, `triggers`, `enableRLS`, `indexes` and `softDelete`. TypeScript autocompletes column names for `primaryKey`, `references` and `softDelete` from the `Row` type. `rpc()` without a body marks an existing function so the SDK types it.

What changes compared with manual mode:

| | Manual mode | Database mode |
| --- | --- | --- |
| Columns | Declared in the schema | From the `Database` type |
| Migrations (DDL) | Generated | Not generated: the tables already exist |
| RLS, triggers, RPCs | Generated | Generated |
| SDK | `types.ts` + `client.ts` | `client.ts`, typed by your `Database` type |
| `validate` column checks | Column names in policies, triggers and indexes are checked | Columns are not known at runtime, so names inside `policy.*` are not checked |

In Database mode the generated `client.ts` imports `Database` from `./database.types`, relative to the SDK output folder. If your types file lives elsewhere, point `adapterOptions.databaseTypes` at it (the path is relative to the SDK folder):

```ts [accessnexus.config.ts]
import { defineConfig } from 'accessnexus';

export default defineConfig({
  adapterOptions: {
    databaseTypes: '../../database.types.js', // from generated/sdk/ to ./database.types.ts
  },
});
```

::: warning Check policy columns yourself in Database mode
In a scratch run, `policy.isOwner('idx')` on a table without an `idx` column passed `validate` in Database mode. Review the generated `<table>_rls.sql` before pushing.
:::

### Which mode to use

- **New project, or you want AccessNexus to own the tables:** manual mode. You get migrations, full static checks and SDK types from one file.
- **Existing project whose tables are managed elsewhere** (Supabase Studio, another migration tool), and you only want RLS, triggers and a typed client: Database mode.
- **Existing project you want to move to AccessNexus completely:** run `init --db-url` to import tables, columns, keys, RLS policies and functions into a manual-mode schema. See [Adopting an existing project](/guide/existing-project).

## Splitting the schema

The schema file can import sibling files; it is bundled with esbuild. Write relative imports with a `.js` extension (`'./db/columns.js'` resolves to `db/columns.ts`), which works with every TypeScript `moduleResolution`.

## Next steps

- [Policies](/guide/policies) - who can read and write each table
- [Triggers](/guide/triggers) - `updatedAt`, soft delete, audit log and column locks
- [Schema API](/api/schema) - full type reference for `defineSchema`, `table` and columns
- [Configuration](/api/seed-config) - `defineConfig` options such as `uuidGeneration`
