# Troubleshooting

Find your problem by symptom (what the app or Postgres says) or by the error code the CLI printed. With `--json`, the code is `error.code` and the fix is `error.hint`. Exit code `1` means you can fix it; `2` is an AccessNexus bug (rerun with `--verbose` and report the stack).

## By symptom

### "new row violates row-level security policy for table ..."

Postgres SQLSTATE `42501`. The written row fails the `WITH CHECK` of an insert or update policy.

| Likely cause | Fix |
| --- | --- |
| The owner column is not the caller (`user_id` missing or someone else's id) | Send `user_id: user.id`; `isOwner` and `definePermissions` pin it on purpose |
| An update moves the row out of the rule (changes the owner or tenant) | Intended: `UPDATE` keeps `WITH CHECK`. Freeze those columns with `trigger.lockColumns` |
| The insert targets a tenant the user is not a member of | Intended (`pinTenant`). Check the membership row exists |
| **The `select` rule does not admit the new row** (see next section) | Add a branch that admits it |

Never fix it by removing policies, `enableRLS: false`, or `policy.public()` for writes.

### `create()` or `update()` fails although the write is allowed

The SDK's `create` and `update` return the row (`INSERT/UPDATE ... RETURNING`), and Postgres checks the returned row against the `select` policy. If `select` does not admit it, the write fails with the RLS error above. Typical cases:

- A membership table whose `select` is "members of the org": the user's own new row is not visible yet. Add `policy.isOwner('user_id')` to `select`.
- A tenant table whose first membership is added by an AFTER INSERT trigger: `RETURNING` is checked before it. Add `'own'` (or `policy.isOwner('created_by')`) to `read`.
- A soft-delete `select` that excludes `deleted_at IS NOT NULL` is fine; but a `select` with a condition the written row does not meet (for example `published = true` only) is not.

### Reads return nothing, or `findById` / `update` return "no rows"

RLS hides rows instead of raising errors. A `SELECT` returns `[]`, a `DELETE` affects 0 rows, the SDK's `findById` / `findOne` (which use `.maybeSingle()`) return `data: null` without an error, and `update` (which uses `.single()`) returns PostgREST error `PGRST116`.

- The table has no `policies` (deny-all, `NO_POLICIES`), or no rule for that operation.
- The request is anonymous: the session expired, or the client was created without the user's session.
- The rule checks a different column than you think: run `validate` (`UNKNOWN_COLUMN` in manual mode is not caught by TypeScript).

### "permission denied for function ..."

A `security: 'definer'` RPC called by an anonymous visitor. EXECUTE is revoked from `anon` by design. Sign in first, or add `allowAnon: true` if anonymous use is intended (and check the caller in the body).

### "stack depth limit exceeded" or "infinite recursion detected in policy"

- The SQL was applied by a role without `BYPASSRLS`, so the membership helpers re-enter their own policy. `push` now refuses this (`PUSH_ROLE_NO_BYPASSRLS`); push again as `postgres`.
- A `policy.custom` subquery reads the same table the policy is on. Use `policy.belongsTo` with a membership table, which compiles to a recursion-safe helper.

### Locked column or soft-delete errors (SQLSTATE 42501)

- `trigger.lockColumns` raised: the user tried to change a frozen column. Intended; change it through the service role or a definer RPC.
- "`<table>.<column>` can only be set by DELETE (soft delete)": a plain `UPDATE` touched the soft-delete column. Delete the row instead; restore through a definer RPC.

### Foreign key error when deleting a parent

Foreign keys default to `ON DELETE NO ACTION`. Set `onDelete: { column: 'cascade' | 'set null' | 'restrict' }`.

### Policies seem to allow more than the schema says

- Old policies created outside AccessNexus (dashboard, earlier migrations) still exist, and Postgres ORs permissive policies. List them: `SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';`

### Drift: the database no longer matches the schema

- `MIGRATION_DRIFT`: an applied migration file was edited. Restore it (`git checkout -- <file>`), change the schema, `generate` a new `__changes` migration.
- Changes made in the dashboard are not detected by `diff`, which compares the schema with files on disk, not with the database. Bring them into the schema, or revert them.

## By CLI error code

### Schema and config

| Code | Fix |
| --- | --- |
| `SCHEMA_NOT_FOUND` | Create `accessnexus.schema.ts` (`init --yes`), pass `--schema`, or set `schema` in the config |
| `SCHEMA_NO_DEFAULT_EXPORT` | End the file with `export default defineSchema({...})` |
| `SCHEMA_INVALID` | A builder rejected the definition (bad identifier, unknown reference, unknown role); the message names it |
| `SCHEMA_VALIDATION_FAILED` | Fix every entry of `issues[]` (see below) |
| `SCHEMA_LOAD_FAILED`, `CONFIG_LOAD_FAILED`, `SEED_LOAD_FAILED` | The file threw or imports a missing package |
| `MODULE_SYNTAX_ERROR` | Syntax error at the location shown |
| `TS_LOADER_MISSING` | esbuild is missing: `npm install -D accessnexus` |
| `CONFIG_NOT_FOUND`, `CONFIG_INVALID` | Fix `--config` or the config's default export |
| `UNKNOWN_COMMAND`, `UNKNOWN_FLAG`, `MISSING_FLAG_VALUE`, `INVALID_FLAG_VALUE`, `UNEXPECTED_ARGUMENT`, `INVALID_FLAGS` | Follow the hint or `--help` |

### Generate, diff and push

| Code | Fix |
| --- | --- |
| `GENERATED_OUT_OF_DATE` | Run `diff` to review, then `generate`, then retry |
| `NOTHING_TO_PUSH` | Run `generate` first (or fix `--output`) |
| `DESTRUCTIVE_MIGRATION` | Nothing was applied. A rename should be a rename in the schema; otherwise confirm data loss (with a backup) and pass `--allow-destructive` |
| `DB_URL_MISSING` | Pass `--url` or set `SUPABASE_DB_URL` / `ACCESSNEXUS_DB_URL` / `DATABASE_URL` |
| `PG_DRIVER_MISSING` | `npm install -D pg` |
| `DB_CONNECTION_FAILED` | Wrong URL, password or network. Use the Session pooler string; local databases may need `?sslmode=disable`; timeout via `ACCESSNEXUS_DB_CONNECT_TIMEOUT` |
| `PUSH_ROLE_NO_BYPASSRLS` | Nothing was applied. Connect as `postgres`, or `ALTER ROLE <role> BYPASSRLS` as a superuser |
| `FOREIGN_POLICIES` | Nothing was applied. A managed table has RLS policies AccessNexus did not generate, which would keep granting access. Review them, port what is still needed into the schema, then `push --replace-foreign-policies` |
| `PUSH_FAILED` | Postgres rejected a file (message included). The whole push was rolled back; nothing from it is applied. Fix the schema, `generate`, push again |
| `MIGRATION_DRIFT` | Restore the applied migration, change the schema, `generate` |
| `ADAPTER_NOT_FOUND`, `ADAPTER_AMBIGUOUS`, `ADAPTER_UNSUPPORTED`, `TARGET_NOT_FOUND` | Only the `supabase` adapter exists |
| `TARGET_INVALID` | Add `adapter: 'supabase'` to the target |

::: tip `GENERATED_OUT_OF_DATE` that `generate` does not fix
If `diff` lists a file as **removed** (`D`), for example `generated/triggers/<table>_triggers.sql` after you removed a table's last trigger, `generate` does not delete it in v0.1.6. Delete that file by hand, then `diff --check` passes. The trigger or function itself stays in the database until you drop it.
:::

A `PUSH_FAILED` on `rpcs.sql` saying "cannot change return type of existing function" means you changed an RPC's `returns`: drop the old function as `postgres`, then push.

### Seed and init

| Code | Fix |
| --- | --- |
| `SEED_NOT_FOUND`, `SEED_EMPTY` | Create or fix `accessnexus.seed.ts` |
| `SEED_FAILED` | Rolled back. Push first; check columns and unique keys (including rows a trigger already creates) |
| `SEED_REMOTE_BLOCKED` | Use a local database, or `--allow-remote-seed` for a disposable one |
| `INIT_NOT_INTERACTIVE` | Add `--yes` |
| `INIT_NEEDS_INPUT` | Pass the flag named in the hint |
| `INIT_DETECT_FAILED` | Run in the project root, or let `init --yes` create a `package.json` |
| `INTERNAL_ERROR` (exit 2) | AccessNexus bug: rerun with `--verbose` and report the stack |

## Schema validation issues

Errors make `validate` fail; warnings should be fixed unless the choice is deliberate.

| Code | Fix |
| --- | --- |
| `UNKNOWN_COLUMN`, `UNKNOWN_TABLE` | Fix the name in the policy, trigger, reference or index |
| `UNKNOWN_COLUMN_TYPE` | Use a supported type (`uuid`, `text`, `int`, `jsonb`, `timestamptz`, `"enum('a','b')"`, ...) |
| `OWNER_COLUMN_NOT_UUID` | `isOwner` needs a `uuid` column |
| `INVALID_POLICY_RULE` | Use `policy.public()`, not the string `'public'` |
| `UNKNOWN_POLICY_OPERATION` | Keys are `select`/`insert`/`update`/`delete`, not `read`/`create` |
| `EMPTY_COMBINATOR` | `policy.any([])` / `policy.all([])` needs rules |
| `MISSING_COLUMNS` | Add `columns` (manual mode) |
| `AUDIT_TABLE_MISMATCH` | Give the audit table `table_name`, `operation`, `old_data`, `new_data`, `changed_at` |
| `RPC_IN_TABLES` | Move RPCs to `defineSchema(tables, { rpcs })` |
| `INVALID_TRIGGER`, `INVALID_REFERENCE` | Fix the trigger or `'table.column'` reference |
| `INVALID_IDENTIFIER`, `RESERVED_IDENTIFIER` | Lowercase snake_case, no keywords (`order` → `orders`) |
| `UNKNOWN_TABLE_KEY` | A typo (`polices:`) or tables nested under `tables:` |
| `INVALID_ENUM_VALUE` | A `belongsTo` `where` value not in the enum (misspelled role) |
| `INVALID_DEFAULT` | `default` is raw SQL: `"'todo'"`, not `'todo'` |
| `INVALID_ON_DELETE` | Unknown action, no foreign key, or `'set null'` on a NOT NULL column |
| `CASCADE_INTO_SOFT_DELETE` | Use `'restrict'` |
| `DUPLICATE_TRIGGER` | Give the second `lockColumns`/`custom` trigger its own `name` |
| `BELONGS_TO_PROFILE_WRITABLE` | Use a membership table, or make the profile column server-written only |
| `RLS_DISABLED_WITH_POLICIES` | Remove `enableRLS: false` |
| `NO_POLICIES` (warning) | Add policies if the client uses the table |
| `RLS_DISABLED` (warning) | Remove `enableRLS: false` unless the table must be open |
| `TENANT_PARENT_UNCHECKED` (warning) | Add the [same-tenant guard](/guide/cookbook#child-of-a-tenant-resource) |
| `NO_PRIMARY_KEY` (warning) | Add `primaryKey` |
| `UNWRAPPED_AUTH_CALL` (warning) | Write `(SELECT auth.uid())` |
| `PUBLIC_WRITE` (warning) | Writes open to anonymous visitors; use an owner or tenant rule |
| `USER_ROW_INSERT_OPEN` (warning) | Use `policy.isOwner('id')` |
| `AUDIT_INSERT_OPEN` (warning) | Set the audit table's `insert` to `policy.none()` |
| `GLOBAL_ROLE_IN_TENANT_TABLE` (warning) | Use a tenant role instead of `hasRole` |
| `SCHEMA_EMPTY` (warning) | Add tables |

## Related

- [Error codes reference](/api/errors)
- [CLI](/guide/cli)
- [Security model](/guide/security)
- [Examples](/guide/cookbook)
