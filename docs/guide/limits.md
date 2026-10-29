# Limits & roadmap

What v0.1.0 does not do, so you can plan around it, and what is planned next. Anything under [Roadmap](#roadmap) is **not available** today.

## Current limits (v0.1.0)

| Area | Limit | What to do |
| --- | --- | --- |
| Adapters | Only Supabase. | Use `adapter: 'supabase'` (the default). |
| Database mode | Generates RLS, triggers, RPCs and the SDK, but no DDL migrations. | Keep your own migrations for tables. |
| Migrations | Generated from snapshot diffs; renames are detected heuristically. | Read `diff` before pushing; look for `-- Destructive:` comments. |
| `push` | Runs as one transaction, so a migration cannot use an enum value that an earlier statement of the same push added (`ALTER TYPE ... ADD VALUE`; Postgres forbids it). | Push the enum change first, then the code that uses the new value. |
| Identifiers | Emitted unquoted: lowercase snake_case, no reserved keywords. | Rename (`order` → `orders`). |
| Columns | RLS cannot restrict which columns are read or updated. | `trigger.lockColumns` for writes; a separate table for private reads. |
| Foreign keys | `ON DELETE NO ACTION` unless `onDelete` says otherwise. | Set `onDelete`. |
| Enums | Each `enum(...)` column gets its own type (`<table>_<column>_enum`). | Cast between them (`v.role::text::org_members_role_enum`). |
| Grants | Definer RPCs are not executable by `anon` unless `allowAnon`. Tables and invoker RPCs keep Supabase's default grants. | RLS protects the rows. |
| RPC returns | Scalar or array column types only; no `SETOF` / `TABLE`. | Return `jsonb`. |
| Removed triggers and RPCs | Removing a trigger or RPC from the schema does not drop it from the database; `generate` does not delete stale output files. (Removed policy operations *are* dropped on the next `push`.) | Drop old functions/triggers and stale files by hand. |
| Seed | Only the table-level `references` map provisions `auth.users` rows. | Declare user references there. |
| `init --db-url` | Imports the `public` schema only; no references to other schemas, composite keys, defaults, checks, indexes, triggers or `ON DELETE`. | Review before the first `generate` ([Existing projects](/guide/existing-project)). |
| Verification | `validate` checks structure, not intent; it does not simulate access. | Test your policies with real users. |
| `diff` | Compares the schema with the generated files and the migration snapshot (`.snapshot.json`), not with the live database. Changes made directly in the database (Studio, hand-written SQL) are invisible to it. | Run `push --dry-run` against the database (it reports foreign policies); a `diff --against-db` mode is planned. |

## Roadmap

| Item | Status |
| --- | --- |
| Supabase adapter, RLS/RBAC generator, CLI, typed SDK, `init` import | Shipped in v0.1.0 |
| Firebase adapter (Firestore Security Rules, Cloud Functions, typed SDK) | Planned, not available |
| Policy testing / access simulation (prove a policy blocks what it should, as a CI gate) | Planned, not available |
| MCP server for coding agents | Planned, not available |
| `diff --against-db` (compare the schema with the live database, not only the snapshot) | Planned, not available |

Planned items have no release date. Follow the [CHANGELOG](https://github.com/accessnexus/accessnexus/blob/main/CHANGELOG.md) for what actually ships.

## Related

- [Security model](/guide/security)
- [Existing projects](/guide/existing-project)
- [Troubleshooting](/guide/troubleshooting)
- [Built for AI agents](/guide/ai-agents)
