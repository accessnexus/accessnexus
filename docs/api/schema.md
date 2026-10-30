# defineSchema / table

Declare the tables, columns, access rules, triggers and RPCs that AccessNexus compiles to SQL and a typed SDK. Guide: [Schema](/guide/schema).

## defineSchema

```ts
// Manual mode: every table declares `columns`
function defineSchema<T extends SchemaDef>(tables: T, options?: SchemaOptions): T;

// Database mode: columns come from a Supabase `Database` type
function defineSchema<DB extends SupabaseDatabase>(
  tables: SupabaseSchemaInput<DB>,
  options?: SchemaOptions,
): SchemaDef;

interface SchemaOptions {
  rpcs?: Record<string, RpcDef>;
}
```

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `tables` | `Record<string, TableDef>` or `SupabaseSchemaInput<DB>` | required | Table name to table definition. Names must be lowercase snake_case. |
| `options.rpcs` | `Record<string, RpcDef>` | `undefined` | Postgres functions built with [`rpc()`](/api/rpc). Stored as a non-enumerable `__rpcs` property, so `Object.keys(schema)` lists only tables. |

The schema file must `export default` the result. The CLI loads it with esbuild, so it may import sibling files.

### Mode detection

The mode is detected at runtime, not from the generic argument:

| Mode | Detected when | Generates |
| --- | --- | --- |
| Manual | at least one table declares `columns` | DDL migrations, RLS, triggers, RPCs, SDK (`types.ts` + `client.ts`) |
| Database | no table declares `columns` | RLS, triggers, RPCs, SDK (`client.ts` typed from your `Database`). No DDL migrations. |

Mixing modes (some tables with `columns`, some without) is reported by `validate` as `MISSING_COLUMNS`.

### Checks performed by defineSchema

`defineSchema` throws an `Error` whose message starts with `[AccessNexus]` (the CLI reports it as `SCHEMA_INVALID`) when:

- a table or column name does not match `/^[a-z][a-z0-9_]*$/`;
- `primaryKey` is not a declared column (manual mode);
- a `references` key is not a declared column (manual mode);
- a reference is not `table.column` or `schema.table.column`;
- a two-part reference (`table.column`) names a table that is not in the schema. Three-part references (`auth.users.id`) are never checked.

Everything else (column types, policy columns, reserved words, trigger options) is checked by `accessnexus validate`; see [Errors](/api/errors#schema-issues).

### Manual mode

```ts
import { defineSchema, policy, rpc, table } from 'accessnexus';

export default defineSchema({
  todos: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      title: 'text',
      done: { type: 'boolean', default: 'false' },
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
}, {
  rpcs: {
    count_open: rpc({
      returns: 'int',
      language: 'sql',
      body: 'SELECT count(*)::int FROM todos WHERE user_id = (SELECT auth.uid()) AND NOT done;',
    }),
  },
});
```

### Database mode

Pass your Supabase-generated `Database` type as the generic argument and omit `columns`. Table names, `primaryKey`, `references` keys and `softDelete` are autocompleted from the type. List only the tables you configure.

```ts
import { defineSchema, policy, rpc } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSchema<Database>({
  profiles: {
    primaryKey: 'id',
    policies: {
      select: policy.isOwner('id'),
      update: policy.isOwner('id'),
    },
  },
}, {
  rpcs: { get_stats: rpc() },
});
```

A Database-mode table accepts `SupabaseTableDef`: `primaryKey`, `references`, `policies`, `triggers`, `enableRLS`, `indexes`, `softDelete`. There is no `columns` and no `onDelete` (no DDL is generated).

::: warning
In Database mode `validate` cannot check column names (it has no column list). A typo in `policy.isOwner('usr_id')` is only caught by Postgres at `push` time.
:::

## table

```ts
function table<TColumns extends Record<string, ColumnInput>>(def: TableDef<TColumns>): TableDef<TColumns>;
```

Returns the definition with two normalizations:

- `enableRLS` becomes `true` when `policies` is set.
- When `softDelete` is set and no `trigger.softDelete` is present, a soft-delete trigger on that column is appended to `triggers`.

## TableDef

```ts
interface TableDef<TColumns extends Record<string, ColumnInput>> {
  columns: TColumns;
  primaryKey?: keyof TColumns & string;
  references?: Partial<Record<keyof TColumns & string, string>>;
  onDelete?: Partial<Record<keyof TColumns & string, ForeignKeyAction>>;
  policies?: TablePolicies;
  triggers?: TableTriggers;
  enableRLS?: boolean;
  indexes?: IndexDef[];
  softDelete?: keyof TColumns & string;
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `Record<string, ColumnInput>` | required (manual mode) | Column name to type string or [`ColumnDef`](#columndef). |
| `primaryKey` | column name | `undefined` | Single-column primary key. Without it `validate` warns `NO_PRIMARY_KEY`; the SDK, seed upserts and soft delete then assume `id`. |
| `compositePrimaryKey` | column names | `undefined` | Instead of `primaryKey`: `['org_id', 'user_id']` → `PRIMARY KEY (org_id, user_id)`. Seed upserts use all of them; not allowed with `softDelete` (`INVALID_PRIMARY_KEY`). |
| `references` | `{ [column]: 'table.column' \| 'schema.table.column' }` | `undefined` | Foreign keys. Equivalent to `references` on a `ColumnDef`; when both are set, the column-level one wins. |
| `onDelete` | `{ [column]: ForeignKeyAction }` | no action | `ON DELETE` action per referencing column. See [Foreign keys](#foreign-keys). |
| `policies` | `TablePolicies` | `undefined` | One rule per operation: `{ select?, insert?, update?, delete? }`, plus `all?` applied to every operation without its own key ([details](/guide/policies#one-rule-for-every-operation-all)), each built with [`policy`](/api/policy) or [`definePermissions`](/api/permissions). |
| `triggers` | `TriggerRule[]` | `[]` | Built with [`trigger`](/api/trigger). |
| `enableRLS` | `boolean` | `true` | Only `false` has an effect: RLS is not enabled for the table. |
| `indexes` | `IndexDef[]` | `[]` | Explicit indexes. See [IndexDef](#indexdef). |
| `softDelete` | column name | `undefined` | DELETE becomes `UPDATE ... SET <column> = NOW()`; the SDK filters `<column> IS NULL`. The column should be `'timestamptz?'`. |

Unknown keys (for example `polices`) are reported by `validate` as `UNKNOWN_TABLE_KEY`.

### RLS defaults

Every table gets `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

| Table definition | Result |
| --- | --- |
| `policies` set | RLS on; operations without a rule are denied. |
| no `policies` | RLS on, no policies: deny-all for `anon` and `authenticated` (service role only). `validate` warns `NO_POLICIES`. |
| `enableRLS: false`, no `policies` | No RLS file is generated; the table is open to the anon key. `validate` warns `RLS_DISABLED`. |
| `enableRLS: false` with `policies` | `validate` error `RLS_DISABLED_WITH_POLICIES`. |

::: warning
`enableRLS: false` makes the table readable and writable by anyone holding your public anon key. Use it only for a table that is meant to be open.
:::

## Column types

A column is a type string, or a [`ColumnDef`](#columndef) object. Append `?` to any type to make it nullable; otherwise the column is `NOT NULL` (primary keys get `PRIMARY KEY` instead).

| Type | Postgres | Generated TS type |
| --- | --- | --- |
| `'uuid'` | `UUID` | `string` |
| `'text'` | `TEXT` | `string` |
| `'varchar'` | `VARCHAR` | `string` |
| `'int'` | `INTEGER` | `number` |
| `'smallint'` | `SMALLINT` | `number` |
| `'bigint'` | `BIGINT` | `number` |
| `'serial'` | `SERIAL` | `number` |
| `'float'` | `DOUBLE PRECISION` | `number` |
| `'decimal'` | `NUMERIC` | `number` |
| `'numeric'`, `'numeric(10)'`, `'numeric(10,2)'` | `NUMERIC`, `NUMERIC(10)`, `NUMERIC(10,2)` | `number` |
| `'boolean'` | `BOOLEAN` | `boolean` |
| `'json'` | `JSON` | `Json` |
| `'jsonb'` | `JSONB` | `Json` |
| `'date'` | `DATE` | `string` |
| `'timestamp'` | `TIMESTAMP` | `string` |
| `'timestamptz'` | `TIMESTAMPTZ` | `string` |
| `'time'` | `TIME` | `string` |
| `'text[]'` | `TEXT[]` | `string[]` |
| `'int[]'` | `INTEGER[]` | `number[]` |
| `'uuid[]'` | `UUID[]` | `string[]` |
| `"enum('a','b')"` | `<table>_<column>_enum` | `'a' \| 'b'` |
| any of the above + `?` | same, nullable | `... \| null` |

Exported types: `ScalarType` (the types above), `NullableType` (`` `${ScalarType}?` ``), `ColumnType` (`ScalarType | NullableType`), `ColumnInput` (`ColumnType | ColumnDef`).

Unknown types are reported as `UNKNOWN_COLUMN_TYPE`, with a suggestion for common aliases (`string` to `text`, `integer` to `int`, `bool` to `boolean`, `datetime` to `timestamptz`, `object` to `jsonb`, ...).

### Enums

Write the values inside `enum(...)`, quoted: `"enum('draft','published')"`. Each enum column gets its own Postgres type named `<table>_<column>_enum`, created with an idempotent `DO $$ ... $$` block. Two enum columns with the same values are still two distinct types: cast through text (`v.role::text::org_members_role_enum`) when comparing them in SQL.

### Primary key defaults

| Primary key type | No `default` set | Effect |
| --- | --- | --- |
| `'uuid'` | `DEFAULT gen_random_uuid()` | `DEFAULT public.accessnexus_uuidv7()` when `adapterOptions.uuidGeneration` is `'v7'` |
| `'bigint'` | `GENERATED ALWAYS AS IDENTITY` | |
| other | none | |

In the SDK's `<Table>Create` type, a `uuid` or `bigint` primary key is optional.

## ColumnDef

```ts
interface ColumnDef {
  type: ColumnType;
  default?: string;
  unique?: boolean;
  check?: string;
  references?: string;
  onDelete?: ForeignKeyAction;
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | `ColumnType` | required | Any type from the table above. |
| `default` | `string` | `undefined` | Raw SQL emitted after `DEFAULT`. See below. |
| `unique` | `boolean` | `false` | Adds `UNIQUE`. |
| `check` | `string` | `undefined` | Raw SQL emitted as `CHECK (<expr>)`, e.g. `'amount >= 0'`. |
| `references` | `string` | `undefined` | Foreign key target: `'table.column'` or `'schema.table.column'` (e.g. `'auth.users.id'`). |
| `onDelete` | `ForeignKeyAction` | no action | `ON DELETE` action. Requires `references`. |

`default` and `check` are emitted verbatim. Functions and numbers need no quotes (`'now()'`, `'gen_random_uuid()'`, `'0'`, `'false'`); a string or enum literal needs its own single quotes inside the JS string: `default: "'todo'"`. A bare word such as `default: 'todo'` would be read by Postgres as a column name; `validate` reports it as `INVALID_DEFAULT`, and also rejects a quoted enum default that is not one of the enum's values.

```ts
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  invoices: table({
    columns: {
      id: 'uuid',
      owner_id: { type: 'uuid', references: 'auth.users.id', onDelete: 'cascade' },
      number: { type: 'text', unique: true },
      amount: { type: 'decimal', check: 'amount >= 0' },
      status: { type: "enum('draft','sent','paid')", default: "'draft'" },
      created_at: { type: 'timestamptz', default: 'now()' },
      notes: 'text?',
    },
    primaryKey: 'id',
    policies: {
      select: policy.isOwner('owner_id'),
      insert: policy.isOwner('owner_id'),
      update: policy.isOwner('owner_id'),
      delete: policy.none(),
    },
  }),
});
```

## Foreign keys

A reference is `'table.column'` (a table in this schema) or `'schema.table.column'` (a table outside it, such as `'auth.users.id'`). It can be declared on the column (`ColumnDef.references`) or in the table's `references` map.

```ts
type ForeignKeyAction = 'cascade' | 'set null' | 'restrict' | 'no action';
```

| `onDelete` | Generated | Effect when the parent row is deleted |
| --- | --- | --- |
| omitted | `REFERENCES t(c)` | Same as `'no action'`: the delete fails while children exist. |
| `'no action'` | `ON DELETE NO ACTION` | The delete fails while children exist (checked at end of statement). |
| `'restrict'` | `ON DELETE RESTRICT` | The delete fails while children exist (checked immediately). |
| `'cascade'` | `ON DELETE CASCADE` | Children are deleted. |
| `'set null'` | `ON DELETE SET NULL` | The column is set to `NULL`. The column must be nullable. |

`validate` reports `INVALID_ON_DELETE` for an unknown action, an `onDelete` on a column without a foreign key, or `'set null'` on a `NOT NULL` column, and `CASCADE_INTO_SOFT_DELETE` for `'cascade'` on a table that uses soft delete.

::: warning
Cascades run as the table owner: RLS does not stop them. Only cascade where deleting the parent should delete every child, whoever owns it.
:::

Tables are emitted in dependency order (referenced tables first). Every foreign key column gets an index (see below).

## IndexDef

```ts
interface IndexDef {
  columns: string[];
  unique?: boolean;
  name?: string;
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `string[]` | required | Indexed columns, in order. |
| `unique` | `boolean` | `false` | `CREATE UNIQUE INDEX`. |
| `name` | `string` | `idx_<table>_<col1>_<col2>_<n>` | `n` is the 1-based position in `indexes`. |

`IndexDef` is not exported from `accessnexus`; write the objects inline.

AccessNexus also creates these indexes automatically (`CREATE INDEX IF NOT EXISTS`):

| Index | Columns | Skipped when |
| --- | --- | --- |
| `idx_<table>_<col>_fk` | each foreign key column | the column is the primary key, is `unique`, or an explicit non-unique single-column index already covers it |
| `idx_<table>_<col>_rls` | each column used by `policy.isOwner`, `policy.belongsTo` or a column side of `policy.matchesField` | the column is the primary key or already indexed above |
| `idx_<table>_active_pk` | `(<primaryKey>) WHERE <softDelete> IS NULL` | the table has no `softDelete` or no `primaryKey` |

## Identifiers

Identifiers are emitted unquoted, so table, column, RPC and trigger names must be lowercase snake_case (`INVALID_IDENTIFIER`) and must not be Postgres reserved words such as `order`, `user`, `group`, `limit`, `select` (`RESERVED_IDENTIFIER`).

## Related types

| Type | Description |
| --- | --- |
| `SchemaDef` | `Record<string, TableDef>` |
| `TableDef<TColumns>` | Manual-mode table, above. |
| `SupabaseTableDef<TRow>` | Database-mode table (no `columns`, no `onDelete`). |
| `SupabaseSchemaInput<DB>` | `{ [table in TableNamesOf<DB>]?: SupabaseTableDef<RowOf<DB, table>> }` |
| `SupabaseDatabase` | Constraint matching any Supabase-generated `Database` type. |
| `TablesOf<DB>`, `TableNamesOf<DB>`, `RowOf<DB, T>`, `InsertOf<DB, T>`, `UpdateOf<DB, T>`, `FunctionsOf<DB>`, `FunctionNamesOf<DB>`, `PublicSchema<DB>` | Helpers over the `public` schema of a `Database` type. |
| `GenericTable`, `GenericSchema` | Structural shapes of a Supabase table and schema. |
| `TablePolicies` | `{ select?: PolicyRule; insert?: PolicyRule; update?: PolicyRule; delete?: PolicyRule }` |
| `TableTriggers` | `TriggerRule[]` |
