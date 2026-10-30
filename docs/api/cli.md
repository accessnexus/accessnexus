# CLI

Complete reference of the `accessnexus` command. Workflow and examples: [CLI guide](/guide/cli).

```sh
npx accessnexus <command> [flags]
npx accessnexus <command> --help
```

| Command | Purpose | Touches the database |
| --- | --- | --- |
| [`init`](#init) | Set up AccessNexus in a project (schema, config, SDK wrappers, AGENTS.md) | only with introspection (read-only) |
| [`validate`](#validate) | Check the schema without writing anything | no |
| [`diff`](#diff) | Show what `generate` would change, without writing | no |
| [`generate`](#generate) | Write migrations, RLS policies, triggers, RPCs and the typed SDK | no |
| [`push`](#push) | Apply the generated SQL to the database | yes |
| [`seed`](#seed) | Insert seed data | yes |
| [`help`](#help-and-version) | Show help (also `--help`, `-h`, or no command) | no |
| [`version`](#help-and-version) | Print the installed version (also `--version`, `-v`) | no |

## Global flags

Accepted by every command.

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | `false` | Print exactly one JSON object on stdout; no colors, no progress output. |
| `--verbose` | boolean | `false` | Debug output on stderr and stack traces on errors. Same as `DEBUG=accessnexus`. |
| `--help`, `-h` | boolean | `false` | Show help for the command (with `--json`: the help as JSON). |
| `--config <path>` | string | `accessnexus.config.{ts,js,mjs}` in cwd | Config file. A missing explicit path is `CONFIG_NOT_FOUND`. |

## Flag parsing

- Flags are strict per command: an unknown flag is `UNKNOWN_FLAG` (with a did-you-mean hint), a positional argument is `UNEXPECTED_ARGUMENT`.
- String flags accept `--flag value` and `--flag=value`. A missing value (end of argv, or the next token starts with `--`) is `MISSING_FLAG_VALUE`.
- Boolean flags take no value: `--flag=x` is `INVALID_FLAG_VALUE`.
- Short aliases: `-h` (`--help`), `-y` (`--yes`, `init` only).
- Negative flags are declared as such (`--no-introspect`, `--no-agents`); there is no generic `--no-<flag>`.

## Config resolution

1. `--config <path>` if given, else the first of `accessnexus.config.ts`, `accessnexus.config.js`, `accessnexus.config.mjs` in the current directory. No config file is fine: defaults apply.
2. The file is bundled with esbuild and imported; its default export (or the module namespace) must be an object (`CONFIG_INVALID`).
3. Values are merged, flags first:

| Setting | Precedence |
| --- | --- |
| Schema file | `--schema` > `config.schema` > `./accessnexus.schema.ts` |
| Seed file (`seed`) | `--seed <path>` > `config.seed` > `./accessnexus.seed.ts` |
| Output folders | `--output <dir>` (every category under `<dir>`, config folders ignored) > `config.output.<category>` > `config.output.dir/<category>` > `./generated/<category>` |
| Policy prefix | `config.adapterOptions.policyPrefix` > `--prefix` > `config.naming.policyPrefix` > `accessnexus` |
| SQL / SDK only | `--sql-only` / `--sdk-only` or `config.generate.sqlOnly` / `sdkOnly`; passing both flags is `INVALID_FLAGS` |
| Database URL | see [Database URL](#database-url) |

All paths resolve from the current working directory. Before running a command, `.env` and `.env.local` in the current directory are loaded; variables already set in the environment are not overridden.

## init

Set up AccessNexus in the current project: `accessnexus.schema.ts` (template, or imported from the database), `accessnexus.config.ts`, SDK wrapper files, an `accessnexus` npm script, and an AccessNexus block in `AGENTS.md` (plus a pointer in `CLAUDE.md` if it exists).

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--yes`, `-y` | boolean | `false` | Non-interactive: accept defaults, never prompt. Required when stdin is not a TTY or with `--json` (`INIT_NOT_INTERACTIVE`). |
| `--src <dir>` | string | detected (`src` or `.`) | Source folder. |
| `--sdk <dir>` | string | `<src>/lib/accessnexus` | SDK output folder. |
| `--prefix <name>` | string | `accessnexus` | Policy name prefix. |
| `--db-url <url>` | string | none | Postgres URL to import tables, RLS policies and functions. Needs `pg`. |
| `--no-introspect` | boolean | `false` | Do not read the database; write a template schema. |
| `--install` | boolean | `false` | With `--yes`: install missing `@supabase/*` packages. |
| `--force` | boolean | `false` | With `--yes`: overwrite an existing `accessnexus.schema.ts`. |
| `--no-agents` | boolean | `false` | Do not write the AccessNexus block into `AGENTS.md` / `CLAUDE.md`. |

Behavior:

- If `accessnexus.schema.ts` exists and `--force` is not set, the schema is kept, the `AGENTS.md` block is refreshed, and the result has `status: 'already_initialized'`.
- With `--yes` in a folder without `package.json`, a minimal one (`"type": "module"`) is created.
- Introspection source, unless `--no-introspect`: `--db-url`; else (non-interactive) a URL in `ACCESSNEXUS_DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL`; else the REST API with a Supabase URL and service key from `.env*` files (tables only, no policies). Otherwise a template schema.

## validate

Load and check the schema; write nothing.

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--schema <path>` | string | `config.schema` or `./accessnexus.schema.ts` | Schema file. |

Exits `1` with `SCHEMA_VALIDATION_FAILED` when any issue has severity `error`; warnings are listed but do not fail. Issue codes: [Errors](/api/errors#schema-issues).

## generate

Write migrations, policies, triggers, RPCs and the SDK. Runs the same checks as `validate` first.

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--schema <path>` | string | `config.schema` or `./accessnexus.schema.ts` | Schema file. |
| `--output <dir>` | string | `./generated` | Put every output folder under `<dir>`, overriding the config's output paths. |
| `--sql-only` | boolean | `false` | Only SQL (migrations, policies, triggers, RPCs). |
| `--sdk-only` | boolean | `false` | Only the typed SDK. |
| `--prefix <name>` | string | `accessnexus` | Policy name prefix. |

Output:

| Folder | Files |
| --- | --- |
| migrations | `<UTC timestamp>__init.sql` on the first run, then `<UTC timestamp>__changes.sql` when the schema changed; `.snapshot.json` (state for the next diff). Timestamp format `YYYYMMDDHHMMSS`. Nothing new when the schema is unchanged. Database mode: none. |
| policies | `<table>_rls.sql` |
| triggers | `<table>_triggers.sql` |
| rpcs | `rpcs.sql` |
| sdk | `types.ts` + `client.ts` (manual), `client.ts` (Database mode) |

A file whose content differs only in the `-- Generated at:` line is left untouched (`unchanged`). Destructive statements in migrations written by this run are reported in `destructive`.

## diff

Show what `generate` would change; write nothing. Run it before `generate`: afterwards there is nothing left to diff.

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--schema <path>` | string | `config.schema` or `./accessnexus.schema.ts` | Schema file. |
| `--output <dir>` | string | `./generated` | Compare against folders under `<dir>`. |
| `--sql-only` | boolean | `false` | Only SQL. |
| `--sdk-only` | boolean | `false` | Only the SDK. |
| `--prefix <name>` | string | `accessnexus` | Policy name prefix. |
| `--check` | boolean | `false` | Exit `1` with `GENERATED_OUT_OF_DATE` when anything would change (for CI). With `--against-db`: exit `1` with `LIVE_DB_CHANGES` when the database would change. |
| `--against-db` | boolean | `false` | Live change plan: rehearse the push against the database (see below). |
| `--url <db-url>` | string | see [Database URL](#database-url) | With `--against-db`. Alias: `--db-url`. |
| `--adapter <name>` / `--target <name>` | string | none | With `--against-db`: same resolution as `push`. |
| `--allow-destructive` | boolean | `false` | With `--against-db`: plan as `push --allow-destructive` would (otherwise a `DESTRUCTIVE_MIGRATION` blocker). |
| `--replace-foreign-policies` / `--replace-foreign-triggers` | boolean | `false` | With `--against-db`: include the drops push would do with these flags (otherwise `FOREIGN_*` blockers). |

Removed files are reported for policies, triggers and RPCs (an extra `.sql` file in those folders). The migrations and SDK folders never report removals.

Without `--against-db`, `diff` compares the schema with the generated **files**, not the database. When a database URL is configured, the result carries a `hint` pointing to `--against-db`.

### Live plan (`--against-db`) {#live-plan-against-db}

`diff --against-db` shows what `push` would really change in the live database. It works by rehearsal:

1. Generate the SQL from the current schema in memory (what `generate` + `push` would apply) and connect (`DB_URL_MISSING`, `PG_DRIVER_MISSING`, `DB_CONNECTION_FAILED`).
2. Take the push advisory lock without waiting: if a push is running, `PUSH_LOCKED`.
3. `BEGIN`, then snapshot the catalog of everything the schema manages: tables, RLS enabled/forced, columns (type via `format_type`, nullability, default via `pg_get_expr`), constraints, indexes, policies (command, permissive, roles, `USING`/`WITH CHECK`), triggers (timing, events, level, `WHEN`, function), the functions the SQL defines or the triggers call (identity arguments, return type, language, volatility, security definer, `proconfig`, body hash, `pg_get_functiondef`) and grants on those tables and functions.
4. Run the push code path in the transaction: the same foreign policy/trigger drops (only with the `--replace-*` flags), the same skip/re-apply rules, the same files in the same order.
5. Snapshot again, `ROLLBACK`, release the lock. Nothing persists: no objects, no `accessnexus_migrations` rows.

The result lists `changes` (`kind`, `object`, `change`, `before`, `after`, `fields`) and `riskyChanges`: function volatility/config/security changes, policy roles widened (for example `authenticated` → `public`), policies, triggers, functions, tables or columns dropped, a column default removed, a type change, `NOT NULL` relaxed, RLS disabled or unforced, `anon`/`PUBLIC` newly granted. Refusals the real push would stop at (`FOREIGN_POLICIES`, `FOREIGN_TRIGGERS`, `DESTRUCTIVE_MIGRATION`, `PUSH_ROLE_NO_BYPASSRLS`) are in `blockers`. When Postgres would reject a file, the command exits `1` with `PUSH_WOULD_FAIL` and `failed` (`file`, `message`, `sqlState`); nothing was persisted.

```bash
npx accessnexus diff --against-db --json
npx accessnexus diff --against-db --check     # CI: exit 1 when push would change the database
```

## push

Apply the generated SQL to the database.

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--url <db-url>` | string | see [Database URL](#database-url) | Postgres connection string. Alias: `--db-url` (the flag `init` uses); passing both with different values is `INVALID_FLAG_VALUE`. |
| `--adapter <name>` | string | none | Adapter to use when `config.adapters` lists several. |
| `--target <name>` | string | none | Entry of `config.targets`. |
| `--dry-run` | boolean | `false` | List the files and destructive statements. With a database URL it also rehearses the push of the files on disk in a rolled-back transaction ([live plan](#live-plan-against-db), returned as `livePlan`) and lists foreign policies and triggers (`foreignPolicies`, `foreignTriggers`, `wouldRefuse`); without one, these are `null`. Nothing persists. |
| `--output <dir>` | string | `./generated` | Read the SQL from folders under `<dir>`. |
| `--prefix <name>` | string | `accessnexus` | Policy name prefix (used by the staleness check). |
| `--schema <path>` | string | `config.schema` or `./accessnexus.schema.ts` | Schema file (used by the staleness check). |
| `--allow-destructive` | boolean | `false` | Apply pending migrations that drop tables/columns, drop types, truncate or change column types. |
| `--replace-foreign-policies` | boolean | `false` | Drop the RLS policies on managed tables that AccessNexus did not generate, in the push transaction (see step 7). |
| `--replace-foreign-triggers` | boolean | `false` | Drop the triggers on managed tables that AccessNexus did not generate, in the push transaction (`FOREIGN_TRIGGERS` otherwise). |
| `--seed` | boolean | `false` | Also run the seed after pushing. |
| `--allow-remote-seed` | boolean | `false` | With `--seed`: allow seeding a hosted Supabase database. |

Steps, in order:

1. Collect `.sql` files (recursively, sorted by path) from the migrations, policies, triggers and rpcs folders. None: `NOTHING_TO_PUSH`.
2. Without `--dry-run`: require a database URL (`DB_URL_MISSING`) and the `pg` driver (`PG_DRIVER_MISSING`).
3. Regenerate the SQL in memory and compare with the files: any difference is `GENERATED_OUT_OF_DATE` (also with `--dry-run`).
4. `--dry-run` stops here (after the [live plan](#live-plan-against-db) rehearsal when a database URL is set).
5. Connect (`DB_CONNECTION_FAILED`). If any file contains `SECURITY DEFINER`, the role must bypass RLS (`PUSH_ROLE_NO_BYPASSRLS`).
6. Take an advisory lock (waits, with a notice, if another push holds it), then `BEGIN` one transaction for everything below. Create `public.accessnexus_migrations` (RLS enabled and forced) if absent.
7. Read `pg_policies` for every table the schema manages. A policy whose name is not one AccessNexus generates (`<prefix>_<table>_<op>`) is foreign: Postgres ORs permissive policies, so it would keep granting access next to the generated ones. Without `--replace-foreign-policies`: `FOREIGN_POLICIES` (message and `foreignPolicies` list table + policy), nothing applied. With it: they are dropped (`droppedPolicies`) in the transaction.
8. If a not-yet-applied migration contains a destructive statement and `--allow-destructive` is not set: `DESTRUCTIVE_MIGRATION`, nothing applied.
9. Apply files in the order migrations, policies, triggers, rpcs, recording each in `accessnexus_migrations`. Checksum: SHA-256 of the SQL without the `-- Generated at:` line.
   - unchanged and applied: skipped (`already_applied`);
   - an applied migration whose content changed: `MIGRATION_DRIFT`;
   - a changed policy, trigger or RPC file: re-applied;
   - SQL error: `PUSH_FAILED` (`failed` names the file).
10. `COMMIT`. Any error before it rolls back the whole push: no migration, policy, trigger, RPC, bookkeeping row or policy drop from it remains (`applied` is `[]`, `rolledBack` lists the files that had run). The advisory lock is released either way.
11. With `--seed`: run the seed (see `seed`). A missing seed file is `SEED_NOT_FOUND`; a failed seed keeps the push and reports the seed error code.

SSL: forced (certificate not verified) when the URL has `sslmode=require|verify-ca|verify-full`, or the host contains `supabase.co` / `supabase.in`, unless the URL has `sslmode=disable`.

::: warning
`push` is the only command that changes the database. Preview with `--dry-run`. Postgres cannot use an enum value added by `ALTER TYPE ... ADD VALUE` in the same transaction: if one push adds an enum value and also uses it (in a default, a policy or an RPC), push the enum change first, then the rest. `--allow-destructive` deletes data; use it only when the loss is intended and backed up. A rename belongs in the schema, not as remove + add.
:::

## seed

Generate the seed SQL from the seed file and run it in one transaction.

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--url <db-url>` | string | see [Database URL](#database-url) | Postgres connection string. Alias: `--db-url` (the flag `init` uses); passing both with different values is `INVALID_FLAG_VALUE`. |
| `--adapter <name>` | string | none | Adapter to use when several are configured. |
| `--target <name>` | string | none | Entry of `config.targets`. |
| `--dry-run` | boolean | `false` | Print the SQL; do not connect. |
| `--schema <path>` | string | `config.schema` or `./accessnexus.schema.ts` | Schema file. |
| `--prefix <name>` | string | `accessnexus` | Policy name prefix. |
| `--seed <path>` | string | `config.seed` or `./accessnexus.seed.ts` | Seed file. |
| `--allow-remote-seed` | boolean | `false` | Allow seeding a hosted Supabase database (`*.supabase.co`, `*.supabase.com`, `*.supabase.in`). |

Errors: `SEED_NOT_FOUND`, `SEED_EMPTY` (the export has no tables), `SEED_REMOTE_BLOCKED`, `SEED_FAILED` (rolled back). Seed format: [defineSeed](/api/seed-config#defineseed).

::: warning
Seeds upsert rows and can create `auth.users` accounts. Run them against local or disposable databases only.
:::

## help and version

| Invocation | Output |
| --- | --- |
| `accessnexus`, `accessnexus help`, `--help`, `-h` | overview |
| `accessnexus help <command>`, `accessnexus <command> --help` | command flags and examples |
| `accessnexus version`, `--version`, `-v` | version string |

All accept `--json`.

## Database URL

`push` and `seed` use the first non-empty value of:

1. `--url` (or its alias `--db-url`)
2. the env var named by `adapterOptions.dbUrlEnv` of the selected target or adapter (or `adapterOptions.datasource.url.env`)
3. `ACCESSNEXUS_DB_URL`
4. `SUPABASE_DB_URL`
5. `DATABASE_URL`

For Supabase use the "Session pooler" connection string (Dashboard, Connect), as the `postgres` role. Passwords are redacted in messages.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `ACCESSNEXUS_DB_URL` | `push`, `seed`, `init` | Database URL (after `--url` and `dbUrlEnv`). |
| `SUPABASE_DB_URL` | `push`, `seed`, `init` | Database URL fallback. |
| `DATABASE_URL` | `push`, `seed`, `init` | Database URL fallback. |
| `<dbUrlEnv>` | `push`, `seed` | Any name configured in `adapterOptions.dbUrlEnv`. |
| `ACCESSNEXUS_DB_CONNECT_TIMEOUT` | `push`, `seed`, `init --db-url` | Connection timeout in seconds (positive number). Default `10`. |
| `ACCESSNEXUS_SEED_PASSWORD` | `seed`, `push --seed` | Password of `auth.users` rows the seed provisions. Default: random per user. |
| `DEBUG` | all | `accessnexus`, `accessnexus*` or `*` (comma or space separated) enables `--verbose`. |
| `NO_COLOR` | all | Any non-empty value disables colors. |
| `FORCE_COLOR` | all | Any value other than `0` enables colors when stdout is not a TTY. Ignored with `--json`. |
| `NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`, `REACT_APP_SUPABASE_URL`, `SUPABASE_URL` | `init` | Project URL for REST introspection, read from `.env`, `.env.local`, `.env.development`, `.env.development.local`. |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_KEY`, `SERVICE_ROLE_KEY` | `init` | Service key for REST introspection (any value starting with `sb_secret_` is preferred). |

Colors are off when stdout is not a TTY, with `NO_COLOR`, and always with `--json`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | User-fixable error: bad flag, missing file, schema error, missing database URL, unreachable database, SQL rejected, stale output, destructive migration without `--allow-destructive`, failed seed. Read `error.hint`. |
| `2` | Internal error (`INTERNAL_ERROR`): an AccessNexus bug. Re-run with `--verbose` and report the stack trace. |

Error codes: [Errors](/api/errors).

## JSON output

With `--json`, stdout carries exactly one JSON object (pretty-printed). Every object has `ok`, `command` and `version`. On failure it also has `error`, and keeps any partial result fields carried by the error (`issues`, `applied`, `stale`, ...). Without `--json`, errors go to stderr as message, `Fix:` hint and (with `--verbose`) stack.

```ts
interface SchemaIssue {
  severity: 'error' | 'warning';
  code: string;        // e.g. 'UNKNOWN_COLUMN'
  path: string;        // e.g. 'posts.policies.update'
  message: string;
  hint?: string;
}

interface ErrorResult {
  ok: false;
  command: string;     // the command as typed (also for UNKNOWN_COMMAND)
  version: string;
  error: { code: string; message: string; hint?: string; stack?: string /* --verbose */ };
  // SCHEMA_VALIDATION_FAILED adds: schemaPath, issues (errors and warnings), summary { errors, warnings }
  //   (validate also adds mode, tables, rpcs)
  [partial: string]: unknown;
}

interface DestructiveStatement {
  file: string;        // migration file, relative to cwd
  line: number;        // 1-based
  kind: 'drop_table' | 'drop_column' | 'alter_column_type' | 'drop_type' | 'truncate';
  sql: string;
}

interface ValidateResult {
  ok: true; command: 'validate'; version: string;
  schemaPath: string;
  mode: 'manual' | 'database';
  tables: Array<{
    name: string;
    columns: number;
    primaryKey: string | null;
    rls: boolean;
    policies: string[];                                   // operations with a rule
    triggers: Array<{ kind: string; name: string | null }>;
  }>;
  rpcs: string[];
  issues: SchemaIssue[];                                  // warnings only
  summary: { errors: number; warnings: number };
}

interface GenerateResult {
  ok: true; command: 'generate'; version: string;
  schemaPath: string;
  mode: 'manual' | 'database';
  files: Array<{
    path: string;
    category: 'migrations' | 'policies' | 'triggers' | 'rpcs' | 'sdk';
    status: 'created' | 'updated' | 'unchanged';
  }>;
  destructive: DestructiveStatement[];                    // in migrations written by this run
  summary: { created: number; updated: number; unchanged: number; files: number; tables: number };
  warnings: SchemaIssue[];
}

interface DiffResult {
  ok: boolean;          // false only with --check and pending changes (GENERATED_OUT_OF_DATE)
  command: 'diff'; version: string;
  schemaPath: string;
  changed: boolean;
  destructive: DestructiveStatement[];                    // in migrations generate would write
  summary: { added: number; modified: number; removed: number };
  changes: Array<{ path: string; status: 'added' | 'modified' | 'removed'; diff: string }>;
  warnings: SchemaIssue[];
  hint?: string;        // set when a database URL is configured: points to diff --against-db
}

// diff --against-db: the live plan (PlanChange, RiskyChange and LivePlan are spelled out in llms.txt)
interface DiffAgainstDbResult extends LivePlan {
  ok: boolean;          // false with --check and changes (LIVE_DB_CHANGES) or when the push would fail (PUSH_WOULD_FAIL)
  command: 'diff'; version: string;
  schemaPath: string;
  againstDb: true;
  adapter: string; target: string | null;
  generatedUpToDate: boolean;                             // false: planned from the schema, run generate before push
  warnings: SchemaIssue[];
}

interface LivePlan {
  database: string;                                       // redacted URL
  wouldApply: string[];                                   // files push would execute
  skipped: Array<{ path: string; reason: 'already_applied' | 'checksum_normalized' }>;
  droppedPolicies: ForeignPolicy[]; droppedTriggers: ForeignTrigger[]; // only with the --replace-* flags
  foreignPolicies: ForeignPolicy[]; foreignTriggers: ForeignTrigger[];
  blockers: Array<{ code: string; message: string; hint?: string }>; // refusals the real push stops at
  failed: null | { file: string | null; code: string; message: string; sqlState: string | null };
  changed: boolean;
  summary: { added: number; modified: number; removed: number };
  changes: Array<{
    kind: 'table' | 'column' | 'constraint' | 'index' | 'rls' | 'policy' | 'trigger' | 'function' | 'grant';
    object: string;                                       // e.g. 'public.notes.accessnexus_notes_select', 'public.fn(uuid)'
    change: 'added' | 'removed' | 'modified';
    before?: Record<string, unknown>; after?: Record<string, unknown>;
    fields?: string[];                                    // modified: properties that differ
  }>;
  riskyChanges: Array<{ code: string; kind: string; object: string; message: string }>;
  persisted: false;
}

interface PushResult {
  ok: true; command: 'push'; version: string;
  dryRun: boolean;
  adapter: string;
  target: string | null;
  plan: Array<{ category: 'migrations' | 'policies' | 'triggers' | 'rpcs'; files: string[] }>;
  destructive?: DestructiveStatement[];                   // --dry-run only: all migration files
  foreignPolicies?: ForeignPolicy[] | null;               // --dry-run only: null = no database URL, not checked
  wouldRefuse?: boolean;                                  // --dry-run only: foreign policies/triggers without their --replace-* flag, or livePlan blockers/failed
  livePlan?: LivePlan | null;                             // --dry-run only: null = no database URL (or unreachable)
  applied: string[];
  droppedPolicies: ForeignPolicy[];                       // dropped by --replace-foreign-policies
  skipped: Array<{ path: string; reason: 'already_applied' | 'checksum_normalized' }>;
  seed:
    | null                                                // no --seed (always null with --dry-run)
    | { path: string; status: 'applied'; authUsers: number; durationMs: number }
    | { path: string; status: 'skipped'; message: string; authUsers: 0 };
}
// push failures keep partial fields:
//   NOTHING_TO_PUSH          dryRun, adapter, target, plan
//   GENERATED_OUT_OF_DATE    dryRun, adapter, target, plan, stale: Array<{ path: string; status: string }>
//   DESTRUCTIVE_MIGRATION    ...plan, applied, skipped, destructive
//   FOREIGN_POLICIES         ...plan, applied: [], skipped, foreignPolicies
//   MIGRATION_DRIFT, PUSH_FAILED   ...plan, applied: [] (rolled back), skipped, rolledBack: string[]; PUSH_FAILED adds failed: string
//   SEED_NOT_FOUND           ...plan, applied, skipped
//   seed failure (any code)  ...plan, applied, skipped, seed: { path, status: 'failed', message }

interface ForeignPolicy {
  schema: string; table: string; policy: string;
  command: string;      // SELECT | INSERT | UPDATE | DELETE | ALL
  permissive: boolean;  // false = RESTRICTIVE
}

interface SeedResult {
  ok: true; command: 'seed'; version: string;
  dryRun: boolean;
  seedPath: string;
  checksum: string;     // SHA-256 of the seed SQL
  rows: number;         // rows in the seed file
  authUsers: number;    // auth.users rows the seed provisions
  applied: boolean;
  sql?: string;         // --dry-run
  durationMs?: number;  // when applied
}

interface InitResult {
  ok: true; command: 'init'; version: string;
  status: 'initialized' | 'already_initialized';
  framework?: string;
  schemaSource?: 'template' | 'database' | 'rest';
  sdkPath?: string;
  policyPrefix?: string;
  installed?: string[];
  files: Array<{ path: string; action: 'created' | 'updated' | 'skipped' }>;
  agents: null | { agentsMd: 'created' | 'updated' | 'unchanged'; claudeMd: 'updated' | 'unchanged' | 'absent' };
  nextSteps?: string[];
}

interface HelpResult {
  ok: true; command: 'help'; version: string;
  topic: string | null;
  commands: Array<{
    name: string;
    summary: string;
    examples: string[];
    flags: Array<{ name: string; kind: 'boolean' | 'string'; value?: string; description: string }>;
  }>;
  exitCodes: Record<'0' | '1' | '2', string>;
  docs: string;         // 'node_modules/accessnexus/llms.txt'
}

interface VersionResult { ok: true; command: 'version'; version: string }
```
