# Limits & roadmap

What v0.4.1-next does not do, so you can plan around it, and what is planned next. Anything under [Roadmap](#roadmap) is **not available** today.

## Current limits (v0.4.1-next)

| Area | Limit | What to do |
| --- | --- | --- |
| Adapters | Only Supabase. | Use `adapter: 'supabase'` (the default). |
| Database mode | Generates RLS, triggers, RPCs and the SDK, but no DDL migrations. | Keep your own migrations for tables. |
| Migrations | Generated from snapshot diffs; renames are detected heuristically. A new `NOT NULL` column without a default fails on a table with rows (`generate` / `diff` warn `NOT_NULL_COLUMN_ADDED`; the live plan and `push` stop with `NOT_NULL_ON_NON_EMPTY_TABLE`). Backfills are SQL you write yourself. | Read `diff` before pushing; look for `-- Destructive:` comments. For data: add the column nullable, `migration data <name>` for the backfill, then make it required (see the [recipe](/guide/cookbook#required-column-on-a-table-with-data)); `migration discard` replaces a migration the database never applied. |
| Index names | Named from their content (`idx_<table>_<columns>[_uniq]`), not their position. Schemas from before 0.4.1 get one migration that renames the old position-based names (`ALTER INDEX ... RENAME`, never drop and create) and drops foreign-key indexes that a declared index already covers. | Review that one migration before the first `push` after upgrading. |
| `push` | Runs as one transaction, so a migration cannot use an enum value that an earlier statement of the same push added (`ALTER TYPE ... ADD VALUE`; Postgres forbids it). | Push the enum change first, then the code that uses the new value. |
| Identifiers | Emitted unquoted: lowercase snake_case (one optional leading `_`), no reserved keywords. | Rename (`order` → `orders`). |
| Columns | RLS cannot restrict which columns are read or updated. | `trigger.lockColumns` for writes; a separate table for private reads. |
| Foreign keys | `ON DELETE NO ACTION` unless `onDelete` says otherwise. | Set `onDelete`. |
| Enums | Each `enum(...)` column gets its own type (`<table>_<column>_enum`). | Cast between them (`v.role::text::org_members_role_enum`), or share one type with [`defineEnum`](/api/tenancy#defineenum). |
| Grants | Definer RPCs are not executable by `anon` unless `allowAnon`, and are always executable by `authenticated` (no option withholds it). Tables and invoker RPCs keep Supabase's default grants. `init --db-url` keeps `anon` where the source allowed it (`anonExecutableFunctions`). | RLS protects the rows. Check the caller in definer bodies. |
| RPC returns | Scalar or array column types, `{ table }` (`RETURNS TABLE`) and `{ setof }`. Composite or `record` results, `OUT` parameters and composite-typed arguments cannot be expressed. | Return `jsonb`, or declare the result with `{ table }` / `{ setof }`. See [RPC return types](/api/rpc#return-types). |
| `tenantInvitations` | Grants by role lists (`inviterRoles`): finer rules such as seat limits or allowed e-mail domains are not built in. | Use your own table, or wrap `accept_invitation` in your own RPC. |
| `onAuthUserCreated` | The trigger lives on `auth.users`, so removing the builder from the schema does not drop it. | Drop the trigger by hand. |
| Removed triggers and RPCs | Removing a trigger or RPC from the schema does not drop it from the database; `generate` does not delete stale output files. (Removed policy operations *are* dropped on the next `push`.) | Drop old functions/triggers and stale files by hand. |
| Seed | Only the table-level `references` map provisions `auth.users` rows. | Declare user references there. |
| `init --db-url` | Imports the `public` schema only; no `CHECK` constraints, non-unique indexes, views, multi-column FKs or generated columns. Types without an AccessNexus equivalent become `text`; triggers with arguments, disabled, `INSTEAD OF`/`TRUNCATE`-only or non-plpgsql ones are left out. Each of these leaves a `// WARNING:` comment. Imported triggers get new names, so the originals must be dropped after the first `push` (`--replace-foreign-triggers` drops the triggers, never their functions: see `keptTriggerFunctions`). Every imported function is re-created with `SET search_path = pg_catalog, public` (reported as `hardenedFunctions`, `// NOTE:` in the schema); trigger functions are always `VOLATILE`. | Review before the first `generate` ([Existing projects](/guide/existing-project)). |
| Composite primary keys | `compositePrimaryKey` creates the key, but `softDelete` and the SDK's by-id helpers need a single `primaryKey`. | Use a single `id` key where you need them. |
| Realtime | Postgres Changes filters take one column (a Realtime limit); DELETE events are not RLS-filtered and `old` holds only the primary key. Channel topics have at most one trailing parameter, and Broadcast payloads are untyped. Policies on `realtime.messages` that `init --db-url` finds are listed, not imported. | Filter the rest on the client; refetch rows by key; port imported channel policies to `channel()`. |
| Edge Functions | Declared functions get wrappers, scaffolds, `verify_jwt` and SDK accessors; deploying is `supabase functions deploy`. Inputs are POST JSON only, and outputs are typed but not validated at runtime. A function removed from the schema keeps its folder. | Deploy with the Supabase CLI; delete removed function folders by hand. |
| Verification | `validate` checks structure, not intent; it does not simulate access. `validate --against-db` only proves that Postgres accepts the SQL. | Test your policies against a real database with the [RLS test kit](/guide/testing), or with real users. |
| `diff --against-db` | Covers the managed tables and the functions the generated SQL defines or the managed triggers call, not other objects (enum types, extensions, other schemas). It reflects what `push` does: an applied migration or an unchanged policy/trigger/RPC file is skipped, so drift made directly in the database after a push is not undone by `push` and does not show in the plan. The rehearsal executes the SQL in a transaction, so it briefly takes the same locks a push would. | Run it before every push; for drift on a file push skips, change the schema so the file is regenerated. |

## Roadmap

| Item | Status |
| --- | --- |
| Supabase adapter, RLS/RBAC generator, CLI, typed SDK, `init` import | Shipped in v0.1.0 |
| Firebase adapter (Firestore Security Rules, Cloud Functions, typed SDK) | Planned, not available |
| Policy testing against a real Postgres (`accessnexus/testing`, `test-db`): see [Testing RLS](/guide/testing) | Shipped |
| Access simulation without a database (prove a policy blocks what it should, as a CI gate) | Planned, not available |
| MCP server for coding agents | Planned, not available |

Planned items have no release date. Follow the [CHANGELOG](https://github.com/accessnexus/accessnexus/blob/main/CHANGELOG.md) for what actually ships.

## Related

- [Security model](/guide/security)
- [Existing projects](/guide/existing-project)
- [Troubleshooting](/guide/troubleshooting)
- [Built for AI agents](/guide/ai-agents)
