# CLI

The `accessnexus` CLI turns `accessnexus.schema.ts` into SQL and a typed SDK, and applies that SQL to your database. This page walks through it by task. For every flag of every command, see the [CLI reference](/api/cli).

```bash
npx accessnexus <command> [flags]
npx accessnexus <command> --help
```

The day-to-day loop is the same for people and for coding agents:

```bash
npx accessnexus validate          # 1. check the schema
npx accessnexus diff              # 2. review the SQL that would change
npx accessnexus generate          # 3. write SQL + SDK
npx accessnexus diff --against-db # 4. what push would really change in the database (riskyChanges)
npx accessnexus push              # 5. apply it
```

`init` also adds an npm script, `"accessnexus": "accessnexus generate"`, so `npm run accessnexus` regenerates.

## Behavior shared by every command

| Behavior | Details |
| --- | --- |
| `--json` | Prints exactly one JSON object on stdout and nothing else (colors off). Every result has `ok`, `command` and `version`; failures add `error: { code, message, hint }`. |
| Exit codes | `0` success, `1` something you can fix (read `error.hint`), `2` an AccessNexus bug (rerun with `--verbose` and report the stack). |
| `--verbose` | Debug output and stack traces. Same as `DEBUG=accessnexus`. |
| `--config <path>` | Config file. Default: `accessnexus.config.ts`, `.js` or `.mjs` in the current folder. |
| No prompts without a TTY | Nothing waits for input when stdin is not a terminal. `init` requires `--yes` there. |
| Strict flags | Unknown commands and flags fail (`UNKNOWN_COMMAND`, `UNKNOWN_FLAG`) with a did-you-mean hint. They are never ignored. |
| Colors | Off when stdout is not a TTY or `NO_COLOR` is set. |

## Set up a project: `init`

```bash
npx accessnexus init               # interactive
npx accessnexus init --yes         # accept defaults, never prompt
```

`init` detects the framework (Next.js app or pages router, Vite, Create React App, plain Node), writes `accessnexus.schema.ts`, `accessnexus.config.ts`, client wrappers next to the SDK folder (default `<src>/lib/accessnexus`), the npm script, and an AccessNexus block in `AGENTS.md`. In an empty folder, `init --yes` first creates a minimal `package.json`.

| Flag | Effect |
| --- | --- |
| `--yes`, `-y` | Non-interactive. Required without a TTY (`INIT_NOT_INTERACTIVE` otherwise). |
| `--db-url <url>` | Import tables, keys, RLS policies and functions from an existing database. |
| `--no-introspect` | Never connect to a database; write a template schema. |
| `--src <dir>`, `--sdk <dir>`, `--prefix <name>` | Source folder, SDK folder, policy name prefix. |
| `--install` | With `--yes`: install missing `@supabase/*` packages. |
| `--force` | With `--yes`: overwrite an existing `accessnexus.schema.ts`. |
| `--no-agents` | Do not write the `AGENTS.md` / `CLAUDE.md` block. |

Re-running `init` is safe: an existing schema is kept (unless `--force`) and the `AGENTS.md` block is replaced in place.

::: warning `init --yes` imports when it finds credentials
With `--yes` and no `--no-introspect`, `init` imports from the database whenever it finds a URL in `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL` or `DATABASE_URL` (including `.env` / `.env.local`), or a Supabase URL plus a secret key in your env files. Pass `--no-introspect` for a template schema. Adopting an existing database is covered in [Existing projects](/guide/existing-project).
:::

## Check the schema: `validate`

```bash
npx accessnexus validate
npx accessnexus validate --json
```

Loads the schema and runs the static checks: unknown tables and columns in policies, wrong column types, reserved names, write rules open to anonymous visitors, missing tenant guards and more. It writes nothing. Errors exit `1` (`SCHEMA_VALIDATION_FAILED`, with every problem in `issues[]`); warnings print but exit `0`.

In manual mode, TypeScript does not check column names inside `policy.*` and `definePermissions` (`policy.isOwner('usr_id')` compiles). `validate` does, so run it after every schema edit. `generate`, `diff` and `push` run the same checks and stop on errors.

The full list of checks is on the [Security model](/guide/security#what-validate-warns-about) and [Troubleshooting](/guide/troubleshooting#schema-validation-issues) pages.

## Review the change: `diff`

```bash
npx accessnexus diff
npx accessnexus diff --json
npx accessnexus diff --check      # exit 1 when generated files are stale (for CI)
```

`diff` computes what `generate` would write and compares it with the files on disk, printing only changed hunks. Run it **before** `generate`: right after `generate` there is nothing left to show. To review afterwards, use `git diff generated/`.

It also lists `destructive` statements (dropped tables or columns, column type changes) in the migration it would write. A rename should be a rename in the schema, not a remove plus an add.

`--check` turns pending changes into a failure: exit `1`, `error.code` `GENERATED_OUT_OF_DATE`, `ok: false` in JSON. A difference in the `-- Generated at:` header line alone never counts as a change.

### Against the live database: `diff --against-db`

Plain `diff` compares the schema with the generated files, not with the database: changes made directly in the database (Studio, hand-written SQL, an imported project) are invisible to it. `diff --against-db` answers "what will `push` actually change?":

```bash
npx accessnexus diff --against-db
npx accessnexus diff --against-db --json
npx accessnexus diff --against-db --check   # CI: exit 1 when push would change the database
```

It connects with the same URL resolution as `push`, takes the push lock (without waiting), opens a transaction, snapshots the catalog of the managed tables and functions, applies exactly what `push` would, snapshots again and rolls back. Nothing persists. The output is grouped by kind, with `before → after` for every changed property:

```text
  Policies:
    ~ public.notes.accessnexus_notes_select
        using: (owner_id = ( SELECT auth.uid() AS uid)) → true
  Functions:
    ~ public.note_count() (risky)
        volatility: STABLE → VOLATILE
        config: search_path=public, work_mem=64MB → search_path=pg_catalog, public

  ⚠ Risky changes: 2
    ! [function_volatility_changed] function public.note_count() STABLE → VOLATILE
    ! [function_config_changed] function public.note_count() config [...] → [...]
```

Review `riskyChanges` (volatility and `SET` config changes, widened policy roles, dropped policies, lost defaults, type changes, RLS disabled, `grant_widened` / `grant_narrowed` on effective access) before pushing. Pass the same `--replace-foreign-policies`, `--replace-foreign-triggers` or `--allow-destructive` you would pass to `push` to see their effect; without them the refusals are listed as `blockers`. If Postgres would reject a file, the command exits `1` with `PUSH_WOULD_FAIL` and names the file and the SQL error. `push --dry-run` runs the same plan automatically (as `livePlan`) when a database URL is set.

## Write SQL and the SDK: `generate`

```bash
npx accessnexus generate
npx accessnexus generate --sql-only               # migrations, policies, triggers, RPCs
npx accessnexus generate --sdk-only               # types.ts + client.ts
npx accessnexus generate --output ./tmp/preview   # everything under another folder
```

| Output | Default path |
| --- | --- |
| Migrations | `generated/migrations/<timestamp>__init.sql`, then `<timestamp>__changes.sql`, plus `.snapshot.json` |
| Policies | `generated/policies/<table>_rls.sql` |
| Triggers | `generated/triggers/<table>_triggers.sql` |
| RPCs | `generated/rpcs/rpcs.sql` |
| SDK | `generated/sdk/types.ts` + `client.ts` (or `output.sdk`) |

Each run reports every file as `created`, `updated` or `unchanged`. Files whose only difference is the `-- Generated at:` line are left untouched. `--output <dir>` puts every output folder under `<dir>`, overriding the paths in the config: useful to preview into a scratch folder.

Everything listed above is derived: never edit it by hand. The client wrapper `init` wrote (`index.ts`, or `server.ts` + `browser.ts` on Next.js) is yours; `generate` never touches it.

## Apply to the database: `push`

```bash
npx accessnexus push --dry-run
npx accessnexus push
npx accessnexus push --url "$SUPABASE_DB_URL"
```

`push` is the only command that changes the database. It applies the generated files in this order: migrations, policies, triggers, RPCs, and records each in `public.accessnexus_migrations` with a checksum. The whole push is one transaction: if any file fails (`PUSH_FAILED`), nothing from that push stays applied, including the bookkeeping rows.

Before touching anything, it refuses to continue when:

| Check | Error code |
| --- | --- |
| Nothing has been generated | `NOTHING_TO_PUSH` |
| The generated SQL no longer matches the schema (you forgot `generate`) | `GENERATED_OUT_OF_DATE` |
| The connected role cannot bypass RLS, and the SQL contains `SECURITY DEFINER` helpers | `PUSH_ROLE_NO_BYPASSRLS` |
| A table the schema manages has RLS policies AccessNexus did not generate (not `<prefix>_<table>_<op>`); they would keep granting access | `FOREIGN_POLICIES` |
| A pending migration drops a table or column, or changes a column type | `DESTRUCTIVE_MIGRATION` |

On later runs, unchanged files are skipped, changed policy, trigger and RPC files are re-applied, and an applied migration that was edited is refused (`MIGRATION_DRIFT`). If another `push` holds the lock on the same database, it prints a notice and waits.

| Flag | Effect |
| --- | --- |
| `--dry-run` | List the files and every destructive statement in the migrations. Needs no database URL or driver; when a URL is set it also rehearses the push in a rolled-back transaction and returns the [live plan](#against-the-live-database-diff-against-db) (`livePlan`) and the foreign policies and triggers. Nothing persists. Still refuses stale SQL. |
| `--allow-destructive` | Apply migrations that drop tables or columns or change column types. |
| `--replace-foreign-policies` | Drop the foreign policies `FOREIGN_POLICIES` listed, inside the push transaction. Only after reviewing them ([Existing project](/guide/existing-project#the-safe-first-push)). |
| `--seed` | After a successful push, run the seed. |
| `--allow-remote-seed` | With `--seed`: allow a hosted Supabase host. |
| `--url <db-url>` | Database URL. `--db-url` is an alias (the flag `init` uses). |
| `--target <name>` | Use a target from `config.targets`. |

::: danger `--allow-destructive` deletes data
Only pass it after reading the destructive statements in `push --dry-run`, with a backup, and (if an agent is driving) with the user's explicit agreement. If the change was meant as a rename, change the schema instead.
:::

`push` needs the `pg` driver (`npm install -D pg`) and must connect as a role with `BYPASSRLS`. On Supabase that is the `postgres` user of the **Session pooler** connection string (Dashboard, Connect).

## Load development data: `seed`

```bash
npx accessnexus seed --dry-run    # print the SQL
npx accessnexus seed
npx accessnexus push --seed       # push, then seed
```

Seeds upsert by primary key, create referenced `auth.users` rows with a random password, and refuse hosted Supabase hosts unless `--allow-remote-seed`. See [Seed](/guide/seed).

## Help and version

```bash
npx accessnexus help              # overview
npx accessnexus help push         # one command (same as: push --help)
npx accessnexus push --help --json
npx accessnexus version           # also: --version, -v
```

`help --json` and `<command> --help --json` return the commands, their flags and the exit codes as one JSON object, which is how an agent can discover the CLI without parsing text.

## Config file

`accessnexus.config.ts` is optional. Every field has a default.

```ts [accessnexus.config.ts]
import { defineConfig } from 'accessnexus';

export default defineConfig({
  schema: './accessnexus.schema.ts',
  seed: './accessnexus.seed.ts',
  output: {
    dir: './generated',                 // base for the folders below
    migrations: './supabase/migrations',
    sdk: './src/lib/accessnexus',       // where the app imports the client from
  },
  naming: { policyPrefix: 'app' },      // policy names: <prefix>_<table>_<operation>
  generate: { sqlOnly: false, sdkOnly: false },
  adapterOptions: {
    dbUrlEnv: 'SUPABASE_DB_URL',        // env var push/seed read the DB URL from
    deterministic: true,                // omit the "Generated at" header line
  },
  targets: {                            // push/seed --target <name>
    staging: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'STAGING_DB_URL' } },
  },
});
```

| Field | Default | Purpose |
| --- | --- | --- |
| `schema` | `./accessnexus.schema.ts` | Schema file (`--schema` overrides it) |
| `seed` | `./accessnexus.seed.ts` | Seed file |
| `output.dir` | `./generated` | Base folder; `migrations`, `policies`, `triggers`, `rpcs`, `sdk` can each be set |
| `naming.policyPrefix` | `accessnexus` | Prefix of generated policy, helper and trigger names |
| `generate.sqlOnly` / `sdkOnly` | `false` | Same as the flags |
| `adapterOptions.dbUrlEnv` | none | Name of the env var holding the database URL |
| `adapterOptions.deterministic` | `false` | Drop the `Generated at:` line so output is byte-stable |
| `targets` | none | Named databases for `push` / `seed --target <name>` |

### Targets

A target names another database. Each target needs `adapter: 'supabase'` (`TARGET_INVALID` otherwise) and usually its own `dbUrlEnv`:

```bash
STAGING_DB_URL=postgresql://... npx accessnexus push --target staging
```

::: warning A target falls back to the generic variables
If the target's env var is not set, `push` and `seed` keep looking in `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL` and `DATABASE_URL`. A shell that has `SUPABASE_DB_URL` pointing at another database will push there. Check the redacted URL in the output, or pass `--url` explicitly in scripts.
:::

## Environment variables

`.env` and `.env.local` in the current folder are loaded by every command. A variable already set in the environment wins over the file.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL`, `DATABASE_URL` | `push`, `seed`, `init` | Database URL, checked in this order after `--url` and `adapterOptions.dbUrlEnv` |
| the name in `adapterOptions.dbUrlEnv` | `push`, `seed` | Project-specific database URL variable |
| `ACCESSNEXUS_SEED_PASSWORD` | `seed`, `push --seed` | Password for seeded `auth.users` rows (local databases only) |
| `ACCESSNEXUS_DB_CONNECT_TIMEOUT` | `push`, `seed`, `init --db-url` | Seconds before `DB_CONNECTION_FAILED` (default 10) |
| `DEBUG=accessnexus` | all | Same as `--verbose` |
| `NO_COLOR` | all | Disable colors |
| `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`, `REACT_APP_SUPABASE_URL`, `SUPABASE_URL` | `init` | Project URL for the REST import (tables only) |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, ... (or any `sb_secret_...` value) | `init` | Secret key for the REST import |

For Supabase, use the **Session pooler** connection string. Local databases may need `?sslmode=disable`.

## Run it in CI

Two checks catch most mistakes before review: `validate` (the schema is sound) and `diff --check` (the committed SQL and SDK match the schema). Neither needs a database.

```yaml [.github/workflows/accessnexus.yml]
name: accessnexus

on:
  pull_request:
  push:
    branches: [main]

jobs:
  schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Validate the schema
        run: npx accessnexus validate
      - name: Generated files are up to date
        run: npx accessnexus diff --check
```

When the second step fails, the log shows the stale hunks. The fix is always local: run `npx accessnexus generate` and commit the result.

::: tip SDK not committed?
`diff --check` compares the SDK too. If your SDK folder is gitignored and generated at build time, check only the SQL: `npx accessnexus diff --check --sql-only`.
:::

::: details Deploying from CI
`push` is safe to automate: it refuses stale SQL and data-losing migrations on its own. Add `pg` as a dev dependency and store the Session pooler URL as a secret:

```yaml
      - name: Push to staging
        run: npx accessnexus push --json
        env:
          SUPABASE_DB_URL: ${{ secrets.STAGING_DB_URL }}
```

A destructive migration fails this step with `DESTRUCTIVE_MIGRATION` and applies nothing. Decide by hand, never by adding `--allow-destructive` to the pipeline.
:::

## Related

- [CLI reference](/api/cli): every flag and JSON shape
- [Error codes](/api/errors)
- [Troubleshooting](/guide/troubleshooting)
- [Seed](/guide/seed)
- [Existing projects](/guide/existing-project)
- [Built for AI agents](/guide/ai-agents)
