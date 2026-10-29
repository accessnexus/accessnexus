# How it works

AccessNexus is a compiler: it reads a TypeScript schema, checks it, and writes SQL and TypeScript files. Only `push` talks to the database. This page follows a schema through that pipeline.

## The pipeline

```
accessnexus.schema.ts  (+ accessnexus.config.ts, accessnexus.seed.ts)
        │
        │  bundled with esbuild and evaluated
        ▼
  schema object  ──►  validate  (static checks: columns, policies, triggers, security warnings)
        │
        │  generate (Supabase adapter)
        ▼
  generated/migrations/  <timestamp>__init.sql, <timestamp>__changes.sql, .snapshot.json
  generated/policies/    <table>_rls.sql
  generated/triggers/    <table>_triggers.sql
  generated/rpcs/        rpcs.sql
  <sdk dir>/             types.ts, client.ts
        │
        │  push: migrations → policies → triggers → rpcs
        ▼
  Postgres  (applied files tracked in public.accessnexus_migrations)
```

1. **Load.** The schema, config and seed files are bundled with esbuild and evaluated. They can import sibling files; TypeScript-only syntax works on Node 20+.
2. **Validate.** The builders reject malformed definitions (bad identifiers, unknown roles) when the file runs. Then `validate` runs static checks that TypeScript cannot: unknown columns in policies, bare-word defaults, open writes, user-row impersonation and more. `generate`, `diff` and `push` run the same checks first.
3. **Generate.** The Supabase adapter compiles each part into SQL and the SDK. The generators are pure functions that return `{ path, content }`; the CLI writes them to disk. The same adapter is available programmatically as `SupabaseAdapter` (see [Adapter API](/api/adapter)).
4. **Push.** The generated files are applied in order, each in its own transaction, and recorded in a tracking table.

## Generated folders

| Folder | Contents | Changes when |
| --- | --- | --- |
| `migrations/` | DDL: `CREATE TABLE`, `ALTER TABLE`, indexes, enum types, plus `.snapshot.json` | Columns, keys, references, indexes or enums change |
| `policies/` | One `<table>_rls.sql` per table: `ENABLE` / `FORCE ROW LEVEL SECURITY`, membership helpers, `DROP POLICY IF EXISTS` + `CREATE POLICY` | Policies or permissions change |
| `triggers/` | One `<table>_triggers.sql` per table with triggers: `CREATE OR REPLACE FUNCTION` + `CREATE TRIGGER` | Triggers or soft delete change |
| `rpcs/` | `rpcs.sql` with every RPC that has a `body` | RPCs change |
| `sdk/` | `types.ts` (row, create, update types and a `Database` type) and `client.ts` (`createAccessNexusClient`) | Anything that changes the shape of tables or RPCs |

All folders default to `./generated/<category>` and can be moved individually in `accessnexus.config.ts` (`output.migrations`, `output.sdk`, ...). `--output <dir>` puts every folder under one directory, which is handy for previewing into a scratch folder.

Policy, trigger and RPC files are **rewritten in full** on each `generate` and are safe to re-apply: they drop and recreate their own policies and replace their own functions. Migrations are **append-only**.

::: tip Database mode
When the schema takes its columns from a Supabase `Database` type, no migrations are generated: the tables already exist. Policies, triggers, RPCs and the SDK are generated as usual. See [Schema](/guide/schema#database-mode).
:::

## Migrations and snapshots

The first `generate` writes `<timestamp>__init.sql` with the full DDL and a `.snapshot.json` next to it. The snapshot stores the schema state that migration produced (abridged here):

```json [generated/migrations/.snapshot.json]
{
  "version": 3,
  "definitionHash": "1fdc1374",
  "schemaHash": "3ec55f9f",
  "schemaState": {
    "tables": {
      "notes": {
        "primaryKey": "id",
        "columns": { "...": "..." },
        "indexes": [ "..." ]
      }
    }
  },
  "lastMigrationFile": "20261029213510__init.sql"
}
```

On the next `generate`, AccessNexus hashes the current schema state and compares it with `schemaHash`:

- **Same hash:** no new migration. Changing only policies or triggers never creates a migration file.
- **Different hash:** it diffs the old `schemaState` against the new one and writes `<timestamp>__changes.sql` with only the incremental DDL, then updates the snapshot.

Adding a `pinned` column to the quick-start `notes` table produced:

```sql [generated/migrations/20261029213549__changes.sql]
-- ============================================
-- AccessNexus: Incremental schema changes
-- ============================================

ALTER TABLE notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false;
```

Renames are detected heuristically. A statement that drops a table or column, or changes a column type, is marked with a `-- Destructive:` comment and reported in the `destructive` field of `generate --json` and `diff --json`. If you meant a rename, make it a rename in the schema rather than remove + add.

::: warning Commit the snapshot
`.snapshot.json` is how the next migration is computed. Commit it with the migrations; deleting it makes the next `generate` start over with a new `__init` file.
:::

## What push does

`push` runs these steps, in order:

| Step | On failure |
| --- | --- |
| Collect the generated SQL files | `NOTHING_TO_PUSH`: run `generate` |
| Resolve the database URL (`--url`, `adapterOptions.dbUrlEnv`, `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL`, `DATABASE_URL`) and load the `pg` driver | `DB_URL_MISSING`, `PG_DRIVER_MISSING` |
| Load and validate the schema, and check that the generated SQL matches it | `SCHEMA_VALIDATION_FAILED`, `GENERATED_OUT_OF_DATE`: run `generate` |
| Connect (10 s timeout, `ACCESSNEXUS_DB_CONNECT_TIMEOUT` to change it) | `DB_CONNECTION_FAILED` |
| Check that the role bypasses RLS when the SQL has `SECURITY DEFINER` helpers | `PUSH_ROLE_NO_BYPASSRLS` |
| Take the push lock | Waits, and prints a notice instead of hanging silently |
| Refuse pending migrations that destroy data, unless `--allow-destructive` | `DESTRUCTIVE_MIGRATION` |
| Apply files: migrations → policies → triggers → rpcs | `PUSH_FAILED` (that file is rolled back) |

Nothing is applied when any check before the last step fails. `push --dry-run` stops after the schema check: it lists the plan and any destructive statements without connecting.

### The tracking table

Every applied file is recorded in `public.accessnexus_migrations`:

| Column | Meaning |
| --- | --- |
| `filename` | Path of the file, e.g. `generated/policies/notes_rls.sql` |
| `category` | `migrations`, `policies`, `triggers` or `rpcs` |
| `checksum` | SHA-256 of the file content, normalized (see below) |
| `hash_strategy` | How the checksum was computed (`normalized_sql_v1`) |
| `applied_at`, `execution_time_ms` | When and how long |
| `success`, `logs` | A failed file is recorded with `success = false` and the Postgres error |

### Content hashing

Before hashing, AccessNexus removes the `-- Generated at:` header line, normalizes line endings and trims the file. A file that only differs by its timestamp therefore has the same checksum and is skipped.

For each file `push` looks up the last successful record:

| Situation | Migration file | Policy, trigger or RPC file |
| --- | --- | --- |
| Never applied | Applied | Applied |
| Applied, same checksum | Skipped (`already_applied`) | Skipped (`already_applied`) |
| Applied, different checksum | **Refused** (`MIGRATION_DRIFT`) | Re-applied (`re-applied: changed`) |

### Drift detection

Applied migrations are immutable. If someone edits one, `push` stops before applying anything else:

```
✗ Migration generated/migrations/20261029213510__init.sql changed after it was applied [MIGRATION_DRIFT]

  Fix: Applied migrations are immutable. Restore the file (e.g. `git checkout -- generated/migrations/20261029213510__init.sql`), change accessnexus.schema.ts instead and run `npx accessnexus generate` to get a new __changes migration.
```

Policy, trigger and RPC files are idempotent, so a changed file is simply applied again.

### Advisory lock

`push` takes a Postgres advisory lock (`pg_try_advisory_lock(hashtext('accessnexus_push_lock'))`) before applying anything and releases it at the end. Two pushes against the same database never interleave: the second one prints that another push holds the lock and waits for it.

### Not one big transaction

Each file runs in its own transaction. If file 3 of 5 fails, files 1 and 2 stay applied (they are listed in `applied` in the JSON output), file 3 is rolled back, and the next `push` resumes from there once you fix the cause.

::: info Policies AccessNexus did not create
Generated policies are named `<prefix>_<table>_<operation>` (default prefix `accessnexus`). `push` only drops policies with those names; policies created by other tools stay in place. Postgres ORs permissive policies together, so remove old policies deliberately once the generated ones cover them.
:::

## Deterministic output

By default each SQL file starts with a `-- Generated at: <timestamp>` line. The SQL body below it is stable for the same schema, and every comparison strips the timestamp line:

- `generate` leaves a file untouched when only that line would change (reported as `unchanged`);
- `diff` ignores it;
- `push` excludes it from the checksum.

For byte-identical output, for example to review `generated/` in pull requests, turn the header line off:

```ts [accessnexus.config.ts]
import { defineConfig } from 'accessnexus';

export default defineConfig({
  adapterOptions: {
    deterministic: true, // omit the "Generated at" header line
  },
});
```

Migration file names still carry the timestamp of the `generate` run that created them.

## Next steps

- [CLI](/guide/cli) - every command and flag
- [Security model](/guide/security) - what the generated SQL guarantees
- [Built for AI coding agents](/guide/ai-agents) - `--json`, exit codes and the agent loop
- [Limits](/guide/limits) - what is not covered
