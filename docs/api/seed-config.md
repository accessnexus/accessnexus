# defineSeed / defineConfig

`defineSeed` declares development data for `accessnexus seed`; `defineConfig` declares project settings in `accessnexus.config.ts`. Guides: [Seed](/guide/seed), [CLI](/guide/cli).

## defineSeed

```ts
// Manual mode: table names checked against the schema
function defineSeed<T extends SchemaDef>(schema: T, data: SeedDataFromSchema<T>): SeedDef;

// Database mode: rows typed by your Supabase Database type
function defineSeed<DB extends SupabaseDatabase>(data: SeedDataFromDatabase<DB>): SeedDef;

type SeedDataFromSchema<T> = { [K in keyof T]?: Array<Record<string, unknown>> };
type SeedDataFromDatabase<DB> = { [K in TableNamesOf<DB>]?: Array<InsertOf<DB, K>> };
type SeedDef = Record<string, Array<Record<string, unknown>>>;
```

| Parameter | Type | Description |
| --- | --- | --- |
| `schema` | `SchemaDef` | The default export of your schema file. Only used for typing: the table keys of `data` must be tables of the schema. Row fields are not typed in manual mode. |
| `data` | object | Table name to array of rows. In Database mode each row is the table's `Insert` type. |

Returns `data` unchanged. Default-export it from the seed file (default path `./accessnexus.seed.ts`, or `seed` in the config, or `--seed <path>`).

```ts
import { defineSeed } from 'accessnexus';
import schema from './accessnexus.schema.js';

export default defineSeed(schema, {
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Admin', email: 'admin@example.com' },
  ],
  posts: [
    { author_id: '00000000-0000-0000-0000-000000000001', title: 'Hello', status: 'published' },
  ],
});
```

```ts
import { defineSeed } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSeed<Database>({
  profiles: [{ id: '00000000-0000-0000-0000-000000000001' }],
});
```

### Generated seed SQL

| Behavior | Detail |
| --- | --- |
| Order | Tables in foreign-key dependency order; tables not in the schema last. Empty arrays are skipped. |
| Statement | `INSERT INTO "<table>" ("c1", ...) VALUES (...) ON CONFLICT ("<pk>") DO UPDATE SET "c" = EXCLUDED."c", ...` (`DO NOTHING` when the row has only the primary key). Re-running is safe. |
| Primary key | `primaryKey`, or `id` when the table has none. |
| Values | `null`/`undefined` to `NULL`; numbers and booleans as literals; objects and arrays as quoted JSON; everything else as a quoted string. |
| Transaction | The whole seed runs in one transaction; a failure rolls it all back (`SEED_FAILED`). |

### Auth users

For each seeded table whose table-level `references` map points a column at exactly `'auth.users.id'`, the seed first inserts every distinct value of that column into `auth.users` (`ON CONFLICT (id) DO NOTHING`), with `email_confirmed_at = NOW()` and the row's `email` field as email (or `NULL`).

| Password source | Result |
| --- | --- |
| `ACCESSNEXUS_SEED_PASSWORD` set | every provisioned user gets that password (hashed with `crypt(..., gen_salt('bf'))`) |
| not set | a random, unknowable password per user |

A column-level `references: 'auth.users.id'` (in a `ColumnDef`) does not trigger provisioning; declare the reference in the table's `references` map for that.

::: warning
Seeds upsert rows and can create loginable `auth.users` accounts. The CLI refuses to seed a hosted Supabase database (`*.supabase.co`, `*.supabase.com`, `*.supabase.in`) without `--allow-remote-seed` (`SEED_REMOTE_BLOCKED`). Never set `ACCESSNEXUS_SEED_PASSWORD` for a database reachable from the internet.
:::

## defineConfig

```ts
function defineConfig(options: DefineConfigOptions): ResolvedConfig;
```

Default-export it from `accessnexus.config.ts` (or `.js` / `.mjs`) at the project root. Every field is optional. Relative paths resolve from the current working directory.

```ts
import { defineConfig } from 'accessnexus';

export default defineConfig({
  schema: './accessnexus.schema.ts',
  seed: './accessnexus.seed.ts',
  output: {
    dir: './generated',
    migrations: './supabase/migrations',
    sdk: './src/lib/accessnexus',
  },
  naming: { policyPrefix: 'app' },
  generate: { sqlOnly: false, sdkOnly: false },
  adapterOptions: {
    dbUrlEnv: 'SUPABASE_DB_URL',
    deterministic: true,
    uuidGeneration: 'v7',
  },
  targets: {
    staging: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'STAGING_DB_URL' } },
    prod: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'PROD_DB_URL' } },
  },
});
```

### DefineConfigOptions

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `schema` | `string` | `'./accessnexus.schema.ts'` | Schema file. `--schema` overrides it. |
| `seed` | `string` | `'./accessnexus.seed.ts'` | Seed file for `seed` and `push --seed`. `seed --seed <path>` overrides it. |
| `output.dir` | `string` | `'./generated'` | Base folder for the defaults below. |
| `output.migrations` | `string` | `'{dir}/migrations'` | Migration SQL files and `.snapshot.json`. |
| `output.policies` | `string` | `'{dir}/policies'` | `<table>_rls.sql` files. |
| `output.triggers` | `string` | `'{dir}/triggers'` | `<table>_triggers.sql` files. |
| `output.rpcs` | `string` | `'{dir}/rpcs'` | `rpcs.sql`. |
| `output.sdk` | `string` | `'{dir}/sdk'` | `types.ts` and `client.ts`. |
| `adapter` | `string` | `'supabase'` | Only `'supabase'` exists (`ADAPTER_UNSUPPORTED` otherwise). |
| `adapterOptions` | `Record<string, unknown>` | `undefined` | Passed to the adapter; see below. |
| `naming.policyPrefix` | `string` | `'accessnexus'` | Prefix of policy, helper and trigger names. `--prefix` overrides it. |
| `generate.sqlOnly` | `boolean` | `false` | Generate only SQL. Same as `--sql-only`. |
| `generate.sdkOnly` | `boolean` | `false` | Generate only the SDK. Same as `--sdk-only`. Passing both flags at once is `INVALID_FLAGS`. |
| `targets` | `Record<string, AccessNexusTarget>` | `undefined` | Named databases for `push` / `seed --target <name>`. |
| `adapters` | `Array<string \| AccessNexusTarget>` | `undefined` | Several adapters to choose from with `--adapter <name>`. Usually omitted. |

`--output <dir>` puts every category under `<dir>` and ignores all `output.*` folder paths from the config.

```ts
interface AccessNexusTarget {
  adapter: string;                         // 'supabase'
  adapterOptions?: Record<string, unknown>; // e.g. { dbUrlEnv: 'PROD_DB_URL' }
}
```

A target without `adapter` is `TARGET_INVALID`; an unknown name is `TARGET_NOT_FOUND`. A target's `adapterOptions` are used to find the database URL and, for `seed`, are merged over the top-level `adapterOptions`.

### adapterOptions

All keys are optional. The SQL-shaping keys are the [SupabaseAdapter options](/api/adapter#options); the CLI also reads `dbUrlEnv`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dbUrlEnv` | `string` | `undefined` | Name of the env var holding the Postgres URL for `push` / `seed`. Checked after `--url`, before the built-in env vars. `datasource: { url: { env: '<NAME>' } }` is accepted as an alternative spelling. |
| `deterministic` | `boolean` | `false` | Omit the `-- Generated at: <timestamp>` header line so output is byte-stable. |
| `uuidGeneration` | `'v4' \| 'v7'` | `'v4'` | `'v7'`: uuid primary keys default to `public.accessnexus_uuidv7()` (time-ordered), and the migration defines that function. |
| `policyPrefix` | `string` | `'accessnexus'` | Same as `naming.policyPrefix`, but takes precedence over both `naming.policyPrefix` and `--prefix`. Prefer `naming.policyPrefix`. |
| `schemaName` | `string` | `'public'` | Schema used in function `search_path` and to qualify tables inside generated functions. |
| `idempotent` | `boolean` | `true` | Emit `DROP POLICY IF EXISTS` / `DROP TRIGGER IF EXISTS` before each create. |
| `timestamps` | `boolean` | `true` | Emit the header comment block of each generated SQL file. |
| `forceRLS` | `boolean` | `true` | Emit `FORCE ROW LEVEL SECURITY` after `ENABLE`. |
| `databaseTypes` | `string` | `'./database.types'` | Database mode: import path of your `database.types` file, relative to the SDK folder. |

::: warning
`forceRLS: false` lets the table owner bypass the policies. Keep the default.
:::

### ResolvedConfig

`defineConfig` returns the options with defaults applied:

```ts
type ResolvedConfig = {
  schema: string;
  seed: string;
  adapter: string;
  output: { dir: string; migrations: string; policies: string; triggers: string; rpcs: string; sdk: string };
  adapterOptions?: Record<string, unknown>;
  targets?: Record<string, AccessNexusTarget>;
  adapters?: Array<string | AccessNexusTarget>;
  naming: { policyPrefix: string };
  generate: { sqlOnly: boolean; sdkOnly: boolean };
};
```

Config file lookup and flag precedence are described in the [CLI reference](/api/cli#config-resolution).

### AccessNexusConfig

`AccessNexusConfig` is an older exported interface with the same `schema`, `output`, `adapter`, `adapterOptions`, `naming` and `generate` fields (with `output` and `adapter` required). The CLI does not use it; type config files with `defineConfig`.
