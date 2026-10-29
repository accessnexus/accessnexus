# SupabaseAdapter

Compiles a schema to Supabase/Postgres SQL and the typed SDK. The CLI uses it for you; use it directly for tests or custom tooling. Every method is pure: it returns files as `{ path, content }` and writes nothing.

```ts
import { SupabaseAdapter } from 'accessnexus';
// also: import { SupabaseAdapter } from 'accessnexus/adapters/supabase';
```

## Constructor

```ts
new SupabaseAdapter(options?: SupabaseAdapterOptions)
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `policyPrefix` | `string` | `'accessnexus'` | Prefix of policy names (`<prefix>_<table>_<op>`), membership helpers, trigger functions and triggers. |
| `schemaName` | `string` | `'public'` | Used in `SET search_path = pg_catalog, <schemaName>` and to qualify tables inside generated functions. Table DDL and policies use unqualified names. |
| `idempotent` | `boolean` | `true` | Emit `DROP POLICY IF EXISTS` / `DROP TRIGGER IF EXISTS` before each create. |
| `timestamps` | `boolean` | `true` | Emit the header comment block of each SQL file. |
| `forceRLS` | `boolean` | `true` | Emit `FORCE ROW LEVEL SECURITY` after `ENABLE ROW LEVEL SECURITY`. |
| `uuidGeneration` | `'v4' \| 'v7'` | `'v4'` | Default for `uuid` primary keys without a `default`: `gen_random_uuid()` or `public.accessnexus_uuidv7()`. With `'v7'` the migration also defines `public.accessnexus_uuidv7()` (RFC 9562 UUIDv7; EXECUTE revoked from `PUBLIC` and `anon`, granted to `authenticated` and `service_role`, and to `anon` only when a v7 table accepts anonymous inserts). |
| `databaseTypes` | `string` | `'./database.types'` | Database mode only: import path of the Supabase `database.types` file, relative to the SDK output folder. |
| `deterministic` | `boolean` | `false` | Omit the `-- Generated at: <timestamp>` header line. |

::: warning
`forceRLS: false` lets the table owner bypass every policy. Keep the default.
:::

In `accessnexus.config.ts` these go under `adapterOptions`; see [defineConfig](/api/seed-config#adapteroptions).

## Methods

| Method | Returns | Files |
| --- | --- | --- |
| `generatePolicies(schema)` | `GeneratedOutput[]` | `<table>_rls.sql` per table, except tables with `enableRLS: false` and no `policies` |
| `generateTriggers(schema)` | `GeneratedOutput[]` | `<table>_triggers.sql` per table with at least one trigger |
| `generateMigrations(schema)` | `GeneratedOutput[]` | `001_initial.sql` with the full DDL; `[]` in Database mode or for an empty schema |
| `generateRpcs(schema)` | `GeneratedOutput[]` | `rpcs.sql` when at least one RPC has a `body`, else `[]` |
| `generateClient(schema)` | `GeneratedOutput[]` | manual mode: `types.ts`, `client.ts`; Database mode: `client.ts` |
| `generateSeed(schema, data, options?)` | `GeneratedOutput[]` | `seed.sql` (always one file) |
| `ruleToSQL(rule)` | `string` | `USING` expression of a policy rule |
| `ruleToCheckSQL(rule)` | `string` | `WITH CHECK` expression of a policy rule |
| `triggerRuleToSQL(rule, tableName, tableDef)` | `string` | function and `CREATE TRIGGER` SQL for one trigger rule |
| `name` | `'supabase'` | adapter identifier (property) |

```ts
interface GeneratedOutput {
  path: string;        // relative file name, e.g. 'profiles_rls.sql'
  content: string;
  overwrite?: boolean; // not set by SupabaseAdapter
}
```

### generatePolicies

RLS for each table: `ENABLE` and `FORCE ROW LEVEL SECURITY`, membership helper functions for `belongsTo` rules (with their `REVOKE` / `GRANT`), then one `CREATE POLICY` per operation. A table without `policies` gets only the `ALTER TABLE` lines and a `-- No policies: deny-all ...` comment. See [policy](/api/policy#how-a-rule-becomes-a-policy).

### generateMigrations

Full DDL from scratch: enum types, the optional `public.accessnexus_uuidv7()` function, `CREATE TABLE IF NOT EXISTS` in dependency order, then explicit and automatic indexes.

The CLI does not write this file as is: `generate` stores `<timestamp>__init.sql` on the first run and `<timestamp>__changes.sql` incremental migrations afterwards, tracked by `.snapshot.json`. That versioning is not part of the adapter API.

### generateClient

The typed SDK. See [SDK](/api/sdk).

### generateSeed

```ts
generateSeed(schema: SchemaDef, data: SeedDef, options?: SeedSqlOptions): GeneratedOutput[];

interface SeedSqlOptions {
  authPassword?: string; // password for provisioned auth.users rows; random when omitted
}
```

Upserts in dependency order and provisions `auth.users` rows. See [defineSeed](/api/seed-config#generated-seed-sql).

### ruleToSQL / ruleToCheckSQL

Low-level compilers for a single rule. Called outside `generatePolicies`, a `belongsTo` rule renders as an inline subquery (`org_id IN (SELECT org_id FROM org_members WHERE user_id = (SELECT auth.uid()))`) instead of the `SECURITY DEFINER` helper used in generated policies.

### triggerRuleToSQL

Compiles one trigger rule for `tableName`. `tableDef` supplies the primary key (soft delete) and the `updatedAt` columns that `lockColumns` must ignore.

## Example

```ts
import { SupabaseAdapter } from 'accessnexus';
import schema from './accessnexus.schema.js';

const adapter = new SupabaseAdapter({ policyPrefix: 'app', deterministic: true });

const files = [
  ...adapter.generateMigrations(schema),
  ...adapter.generatePolicies(schema),
  ...adapter.generateTriggers(schema),
  ...adapter.generateRpcs(schema),
  ...adapter.generateClient(schema),
];

for (const file of files) {
  console.log(file.path, file.content.length);
}
```

Snapshot test of one table's policies:

```ts
import { SupabaseAdapter, defineSchema, policy, table } from 'accessnexus';

const schema = defineSchema({
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isOwner('owner_id'), insert: policy.isOwner('owner_id') },
  }),
});

const [rls] = new SupabaseAdapter({ deterministic: true }).generatePolicies(schema);
export const sql: string = rls.content; // CREATE POLICY "accessnexus_notes_select" ...
```

## Adapter interface

`SupabaseAdapter` implements the exported `Adapter` interface:

```ts
interface Adapter {
  readonly name: string;
  generatePolicies(schema: SchemaDef): GeneratedOutput[];
  generateClient(schema: SchemaDef): GeneratedOutput[];
  generateMigrations?(schema: SchemaDef): GeneratedOutput[];
  generateTriggers?(schema: SchemaDef): GeneratedOutput[];
  generateRpcs?(schema: SchemaDef): GeneratedOutput[];
  generateSeed?(schema: SchemaDef, data: SeedDef, options?: SeedSqlOptions): GeneratedOutput[];
}
```

The CLI only runs the `supabase` adapter.
