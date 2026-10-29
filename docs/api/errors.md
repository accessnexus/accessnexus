# Errors

Every CLI error code and every schema issue code, generated from the source (`CliError` codes in `src/cli/**`, issue codes in `src/cli/schema-check.ts`). Walkthroughs: [Troubleshooting](/guide/troubleshooting).

There are two kinds:

- **CLI errors** stop the command. They have a stable `code`, a `message` and usually a `hint`; in `--json` mode they are in `error`. Exit code `1` unless noted.
- **Schema issues** are found by the static checks that `validate`, `generate`, `diff` and `push` run before producing SQL. Each has `severity`, `code`, `path` (e.g. `posts.policies.update`), `message` and usually `hint`. Any issue with severity `error` makes the command fail with `SCHEMA_VALIDATION_FAILED` and the full list in `issues`.

```ts
interface SchemaIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
  hint?: string;
}
```

## CLI errors

### Usage

| Code | Commands | Meaning | Fix |
| --- | --- | --- | --- |
| `UNKNOWN_COMMAND` | any | The first argument is not a command. | Use the suggested command; `accessnexus help` lists them. |
| `UNKNOWN_FLAG` | any | A flag is not accepted by this command. | Use the suggested flag; `<command> --help` lists them. |
| `UNEXPECTED_ARGUMENT` | any | A positional argument was passed; commands take flags only. | Prefix it with `--`, or remove it. |
| `MISSING_FLAG_VALUE` | any | A string flag has no value (end of input, or the next token starts with `--`). | `--flag value` or `--flag=value`. |
| `INVALID_FLAG_VALUE` | any | A boolean flag was given a value (`--json=true`). | Pass the flag alone. |
| `INVALID_FLAGS` | `generate`, `diff`, `push`, `seed` | `--sql-only` together with `--sdk-only`, or `--target` whose adapter differs from `--adapter`. | Pass at most one of the pair; pass only `--target`. |

### Config and file loading

| Code | Commands | Meaning | Fix |
| --- | --- | --- | --- |
| `CONFIG_NOT_FOUND` | all except `init` | `--config <path>` does not exist. | Fix the path, or drop `--config`. |
| `CONFIG_INVALID` | all except `init` | The config file does not export an object. | `export default defineConfig({ ... })`. |
| `CONFIG_LOAD_FAILED` | all except `init` | The config threw while running, or imports a module that cannot be found. | Fix the named import or error; install a missing package. |
| `SCHEMA_NOT_FOUND` | `validate`, `generate`, `diff`, `push`, `seed` | No schema file at the resolved path. | `accessnexus init --yes`, `--schema <path>`, or `schema` in the config. |
| `SCHEMA_NO_DEFAULT_EXPORT` | same | The schema file has no default export. | End it with `export default defineSchema({ ... })`. |
| `SCHEMA_LOAD_FAILED` | same | The schema threw while running, or imports a module that cannot be found. | Fix the named import or error. |
| `SCHEMA_INVALID` | same | A builder threw: `defineSchema` (bad identifier, unknown primary key or reference column, bad or dangling reference) or `definePermissions` (unknown role, tenant scope without tenant config, unknown resource, missing `ownerColumn` / `tenantColumn` / `roleColumn`). | Fix the definition named in the message. See [definePermissions errors](/api/permissions#errors). |
| `SCHEMA_VALIDATION_FAILED` | same | The static checks found at least one issue with severity `error`. | Fix each entry of `issues` at its `path` as its `hint` says. See [Schema issues](#schema-issues). |
| `SEED_LOAD_FAILED` | `seed`, `push --seed` | The seed file threw while running, or imports a module that cannot be found. | Fix the named import or error. |
| `MODULE_SYNTAX_ERROR` | any that loads a file | The config, schema or seed file does not compile; the message has `file:line:column`. | Fix the syntax or TypeScript error. |
| `TS_LOADER_MISSING` | any that loads a file | esbuild is not available and Node cannot load the TypeScript file natively. | Reinstall (`npm install -D accessnexus`), or use Node.js >= 22.18. |

### Generated output

| Code | Commands | Meaning | Fix |
| --- | --- | --- | --- |
| `GENERATED_OUT_OF_DATE` | `diff --check`, `push` | Generated files differ from what the schema produces. The JSON keeps the diff (`diff`) or `stale` (`push`). | Review `accessnexus diff`, run `accessnexus generate`, retry. |
| `NOTHING_TO_PUSH` | `push` | No `.sql` files in the output folders. | Run `generate` first, or point `--output` / the config at the generated folder. |

### Database and push

| Code | Commands | Meaning | Fix |
| --- | --- | --- | --- |
| `DB_URL_MISSING` | `push`, `seed` | No database URL from `--url` (alias `--db-url`), `dbUrlEnv`, `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL` or `DATABASE_URL`. | Pass `--url` or set one of them (shell, `.env`, `.env.local`). Use `--dry-run` to preview without a database. |
| `PG_DRIVER_MISSING` | `push`, `seed`, `init --db-url` | The optional `pg` peer dependency is not installed (or exports no `Client`). | `npm install -D pg`. |
| `DB_CONNECTION_FAILED` | `push`, `seed`, `init --db-url` | Connection failed or timed out (10 s default). | Check URL, password and network. Supabase: "Session pooler" string. Local: `?sslmode=disable`. Timeout: `ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds>`. |
| `PUSH_ROLE_NO_BYPASSRLS` | `push` | The SQL contains `SECURITY DEFINER` helpers, but the connected role does not bypass RLS. Nothing applied. | Connect as `postgres`, or `ALTER ROLE <role> BYPASSRLS` as a superuser. |
| `DESTRUCTIVE_MIGRATION` | `push` | A pending migration drops a table, column or type, truncates, or changes a column type. Nothing applied; `destructive` lists the statements. | A rename: rename in the schema. Intended loss: back up, then `push --allow-destructive`. |
| `FOREIGN_POLICIES` | `push` | A table the schema manages has RLS policies whose names are not `<prefix>_<table>_<op>` (not generated by AccessNexus). Permissive policies OR together, so they would keep granting access. Nothing applied; the message and `foreignPolicies` list table + policy. | Port any rule still needed into the schema, review, then `push --replace-foreign-policies` (drops them in the push transaction). See [Existing project](/guide/existing-project). |
| `MIGRATION_DRIFT` | `push` | An already-applied migration file was edited. The push was rolled back. | Restore the file, change the schema, run `generate` for a new `__changes` migration. |
| `PUSH_FAILED` | `push` | Postgres rejected a file (message has the SQL error; `failed` names it). The push runs in one transaction, so all of it was rolled back: `applied` is `[]` and `rolledBack` lists the files that had run. | Fix the cause in the schema (or the database state), `generate`, `push` again. |

### Adapter and target

| Code | Commands | Meaning | Fix |
| --- | --- | --- | --- |
| `ADAPTER_NOT_FOUND` | `push`, `seed` | `--adapter <name>` matches no configured adapter. | Use one listed in the hint. |
| `ADAPTER_AMBIGUOUS` | `push`, `seed` | `config.adapters` lists several adapters and none was chosen. | Pass `--adapter` or `--target`. |
| `ADAPTER_UNSUPPORTED` | `push`, `seed` | The selected adapter is not `supabase`. | `adapter: 'supabase'`. |
| `TARGET_NOT_FOUND` | `push`, `seed` | `--target <name>` is not in `config.targets`. | Use a listed target, or define it. |
| `TARGET_INVALID` | `push`, `seed` | The target has no `adapter` string. | Add `adapter: 'supabase'` to it. |

### Seed

| Code | Commands | Meaning | Fix |
| --- | --- | --- | --- |
| `SEED_NOT_FOUND` | `seed`, `push --seed` | The seed file does not exist. With `push --seed` the SQL was already pushed. | Create `accessnexus.seed.ts`, pass `--seed <path>`, or set `seed` in the config. |
| `SEED_EMPTY` | `seed`, `push --seed` | The seed file's default export is not an object or has no tables. | `export default defineSeed(schema, { table: [rows] })`. |
| `SEED_REMOTE_BLOCKED` | `seed`, `push --seed` | The URL is a hosted Supabase database (`*.supabase.co`, `.com`, `.in`). | Use a local database, or `--allow-remote-seed` for a disposable project. |
| `SEED_FAILED` | `seed`, `push --seed` | Postgres rejected the seed; it was rolled back. | Run `push` first; make rows match the schema (unique keys, references). |

With `push --seed`, any seed error keeps its own code, its message is prefixed with `Push succeeded, but the seed failed:`, and the JSON has `seed.status: 'failed'`.

### init

| Code | Meaning | Fix |
| --- | --- | --- |
| `INIT_NOT_INTERACTIVE` | `init` would prompt, but stdin is not a TTY (or `--json` is set). | Add `--yes`. |
| `INIT_NEEDS_INPUT` | A question has no answer in non-interactive mode. | Pass the flag named in the hint. |
| `INIT_DETECT_FAILED` | The project could not be detected (usually no `package.json`). | Run in the project root, `npm init -y`, or `init --yes` (creates a minimal `package.json`). |

### Internal

| Code | Exit | Meaning | Fix |
| --- | --- | --- | --- |
| `INTERNAL_ERROR` | `2` | Any unexpected exception: an AccessNexus bug. | Re-run with `--verbose` (or `DEBUG=accessnexus`) and report the stack trace. |

## Schema issues

Static checks run by `validate`, `generate`, `diff` and `push`. In Database mode, checks that need column lists are skipped, and `UNKNOWN_TABLE` is a warning instead of an error.

### Schema structure

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `SCHEMA_NOT_AN_OBJECT` | error | `(default export)` | The default export is not an object. | `export default defineSchema({ ... })`. |
| `SCHEMA_EMPTY` | warning | `(schema)` | The schema has no tables. | Add tables. |
| `INVALID_TABLE` | error | `<table>` | A table entry is not an object. | `<table>: table({ ... })`. |
| `RPC_IN_TABLES` | error | `<table>` | An `rpc()` was placed among the tables. | Pass it in `defineSchema(tables, { rpcs: { ... } })`. |
| `UNKNOWN_TABLE_KEY` | error | `<table>.<key>` | Unknown table option (it would be ignored, e.g. `polices`), or tables nested under a key such as `tables:`. | Use the suggested option; valid: `columns`, `primaryKey`, `references`, `onDelete`, `policies`, `triggers`, `enableRLS`, `indexes`, `softDelete`. |
| `MISSING_COLUMNS` | error | `<table>.columns` | Some tables declare `columns` and this one does not. | Declare columns on every table (manual) or on none (Database mode). |

### Identifiers

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `INVALID_IDENTIFIER` | error | table, column, `rpcs.<name>`, or trigger | A table, column, RPC, `lockColumns` `name` or `custom` trigger `name` is not lowercase snake_case (one leading `_` is allowed). | Rename, e.g. `user_profiles`. |
| `INVALID_PRIMARY_KEY` | error | `<table>.compositePrimaryKey` or `<table>.softDelete` | `compositePrimaryKey` lists fewer than two columns, is set together with `primaryKey`, or is combined with `softDelete`. | Use `primaryKey` for one column, `compositePrimaryKey` for several, and a single key for soft delete. |
| `RESERVED_IDENTIFIER` | error | table or column | A table or column name is a reserved SQL keyword (`order`, `user`, `group`, ...). Identifiers are emitted unquoted. | Rename, e.g. `orders`, `user_id`. |

### Columns

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `INVALID_COLUMN` | error | `<table>.columns.<col>` | A column is neither a type string nor `{ type, ... }`. | `email: 'text'` or `email: { type: 'text', unique: true }`. |
| `UNKNOWN_COLUMN_TYPE` | error | `<table>.columns.<col>`, `rpcs.<name>.args.<arg>` | Unknown column or RPC argument type. | Use a [supported type](/api/schema#column-types); the hint suggests one for common aliases. |
| `INVALID_DEFAULT` | error | `<table>.columns.<col>.default` | `default` is a bare word Postgres would read as a column name, or an enum default that is not one of the values. | Quote literals inside the string: `default: "'todo'"`; functions as is: `'now()'`. |
| `NO_PRIMARY_KEY` | warning | `<table>.primaryKey` | The table has no `primaryKey`. | `primaryKey: 'id'` (needed by `findById`, update/delete by id, soft delete, seed upserts). |
| `UNKNOWN_COLUMN` | error | where the column is used | A column named in `primaryKey`, `references`, `onDelete`, `softDelete`, `indexes`, a policy rule (`isOwner`, `belongsTo` and its `through` keys and `where`, `matchesField`) or a trigger (`updatedAt`, `softDelete`, `auditLog.columns`, `lockColumns`) does not exist. | Use a listed column, or add it to `columns`. |

### Keys and references

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `INVALID_REFERENCE` | error | `<table>.references.<col>` | Not `table.column` or `schema.table.column`. | `'profiles.id'`, `'auth.users.id'`. |
| `UNKNOWN_TABLE` | error (manual), warning (Database) | reference, policy or trigger path | A reference, a `belongsTo` `through.table`, a `belongsTo` without `through` (needs `profiles`), or an `auditLog` target names a table not in the schema. | Define the table, fix the spelling, or use `schema.table.column` for tables outside `public`. |
| `INVALID_ON_DELETE` | error | `<table>.columns.<col>` or `<table>.onDelete.<col>` | Unknown action, `onDelete` on a column without `references`, or `'set null'` on a `NOT NULL` column. | Use `'cascade' \| 'set null' \| 'restrict' \| 'no action'`; add `references`; make the column nullable. |
| `CASCADE_INTO_SOFT_DELETE` | error | `<table>.onDelete.<col>` | `onDelete: 'cascade'` on a soft-delete table: the children would keep pointing at a deleted parent. | `'restrict'` (soft-delete children first), `'set null'`, or drop `softDelete`. |

### RLS and policies

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `NO_POLICIES` | warning | `<table>.policies` | No policies: RLS is on, so the API (anon and signed-in) can neither read nor write the table. | Add policies if the client uses the table; keep it for server-only tables (or `policy.none()` per operation). |
| `RLS_DISABLED` | warning | `<table>.enableRLS` | `enableRLS: false`: anyone with the anon key can read and write the table. | Remove `enableRLS: false` and add policies. |
| `RLS_DISABLED_WITH_POLICIES` | error | `<table>.enableRLS` | `enableRLS: false` together with `policies`. | Remove `enableRLS: false`. |
| `INVALID_POLICIES` | error | `<table>.policies` | `policies` is not an object. | `{ select: policy.isAuthenticated() }`. |
| `UNKNOWN_POLICY_OPERATION` | error | `<table>.policies.<op>` | Key is not `select`, `insert`, `update` or `delete` (e.g. `read`, `create`). | Use the SQL operation names; `read`/`create` belong in `definePermissions`. |
| `INVALID_POLICY_RULE` | error | `<table>.policies.<op>` | Not built with `policy.*` (e.g. `'public'`), `hasRole` without a role, or `custom` with an empty expression. | `policy.public()`, `policy.hasRole('admin')`, a non-empty SQL expression. |
| `UNKNOWN_POLICY_KIND` | error | `<table>.policies.<op>` | A rule object has an unknown `kind`. | Build rules with `policy.*`. |
| `EMPTY_COMBINATOR` | error | `<table>.policies.<op>` | `policy.any([])` or `policy.all([])`. | Pass at least one rule, or use `policy.none()`. |
| `OWNER_COLUMN_NOT_UUID` | error | `<table>.policies.<op>` | `policy.isOwner(col)` on a non-`uuid` column. | Make the column `uuid`. |
| `INVALID_ENUM_VALUE` | error | `<table>.policies.<op>` | A `belongsTo` `through.where` value is not a value of that enum column (e.g. a misspelled role). | Use one of the listed values. |

### Security warnings and errors

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `PUBLIC_WRITE` | warning | `<table>.policies.<insert\|update\|delete>` | `policy.public()` lets anonymous visitors write. | `isAuthenticated()`, `isOwner(col)`, a tenant rule, or `policy.none()`. Keep `public()` only for a deliberate anonymous form, combined with a check. |
| `USER_ROW_INSERT_OPEN` | warning | `<table>.policies.insert` | The primary key references `auth.users.id`, but `insert` is `isAuthenticated()` or `public()`: anyone can create another user's row. | `insert: policy.isOwner('<pk>')`. |
| `GLOBAL_ROLE_IN_TENANT_TABLE` | warning | `<table>.policies.<op>` | The table checks tenant membership but also uses a global app role (`hasRole` or a role array). | For org/team roles use `{ scope: 'tenant', roles }` or `belongsTo(..., { where: { role } })`. |
| `TENANT_PARENT_UNCHECKED` | warning | `<table>.references.<col>` | A tenant-scoped row references another tenant-scoped table and no custom trigger checks they are in the same tenant (foreign keys ignore RLS). | Add the same-tenant guard `trigger.custom` from the hint, and `trigger.lockColumns` on both columns. |
| `BELONGS_TO_PROFILE_WRITABLE` | error | `<table>.policies.<op>` | `belongsTo(col)` without `through` trusts `profiles.<col>`, but users can insert profiles or update that column (or profiles has RLS off). | Use `through` (membership table), or make `profiles.<col>` server-written: `insert: policy.none()` and `trigger.lockColumns({ columns: ['<col>'] })`. |
| `UNWRAPPED_AUTH_CALL` | warning | policy, `lockColumns` trigger or `rpcs.<name>.body` | A bare `auth.uid()`, `auth.jwt()` or `auth.role()` in `policy.custom`, a `lockColumns` `unless`, or an RPC body is re-evaluated per row. | Write `(SELECT auth.uid())`. |

### Triggers

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `INVALID_TRIGGERS` | error | `<table>.triggers` | `triggers` is not an array. | `triggers: [trigger.updatedAt('updated_at')]`. |
| `INVALID_TRIGGER` | error | `<table>.triggers[<i>]` | Not built with `trigger.*`; unknown kind; `lockColumns` without exactly one of `columns` / `except`; `custom` with no events, an unknown event, an empty `functionBody`, or `security` not `'invoker'`/`'definer'`. | Fix the option named in the message. |
| `DUPLICATE_TRIGGER` | error | `<table>.triggers[<i>]` | Two triggers produce the same name on one table and would replace each other. | Give each `lockColumns` / `custom` a distinct `name`; do not add `trigger.softDelete` when the table sets `softDelete`. |
| `AUDIT_TABLE_MISMATCH` | error | `<table>.triggers[<i>]` | The audit table lacks `table_name`, `operation`, `old_data`, `new_data`, `changed_at`, or has required columns the trigger never fills. | Add those columns; make the others nullable or give them a default. |
| `AUDIT_INSERT_OPEN` | warning | `<audit>.policies.insert` | The audit table lets API users insert (forged entries). The trigger does not need it. | `insert: policy.none()`. |

### RPCs

| Code | Severity | Path | Meaning | Fix |
| --- | --- | --- | --- | --- |
| `INVALID_RPC` | error | `rpcs.<name>` | An entry of `rpcs` was not created with `rpc()`. | `rpcs: { name: rpc({ ... }) }`. |

RPCs also produce `INVALID_IDENTIFIER` (name or argument name), `UNKNOWN_COLUMN_TYPE` (argument type), `INVALID_DEFAULT` (an argument default that is not a SQL string, or an argument without default after one with a default) and `UNWRAPPED_AUTH_CALL` (body).
