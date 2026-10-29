# Introduction

AccessNexus (`accessnexus` on npm) is a **schema-first engine for Supabase**. You describe your tables and access rules once, in TypeScript, and it generates the SQL your database needs: migrations, Row-Level Security (RLS) policies, role checks, triggers, Postgres functions (RPCs) and a typed client SDK.

It is not an ORM and it does not run your queries. It compiles a declarative schema into SQL files you can read, commit and push.

## The problem

On Supabase, the browser talks to Postgres directly through the API. RLS is the only thing standing between the anon key and your data, and it is easy to get wrong:

- **RLS is hard to write correctly.** Policies are verbose SQL with subtle traps: a bare `auth.uid()` evaluated once per row, membership checks that recurse into the table they protect, `SECURITY DEFINER` helpers without a pinned `search_path`, UPDATE policies without a `WITH CHECK` that let a user move a row out of their reach.
- **Policies drift from the code.** They live in a pile of migrations, edited by hand, with no single place that says who can do what.
- **Mistakes only show up at runtime.** A wrong policy compiles fine. You find out when a user gets an empty list, or when someone reads rows they should not.

AccessNexus puts the access rules next to the table definition, compiles them with the Supabase best practices built in, and runs static checks on the schema before anything reaches Postgres.

## What it generates

From a single `accessnexus.schema.ts`:

| Output | Details |
| --- | --- |
| Migrations | Timestamped DDL (`<timestamp>__init.sql`, then `<timestamp>__changes.sql`) plus a `.snapshot.json` used to compute the next diff |
| RLS policies | `ENABLE` + `FORCE ROW LEVEL SECURITY` on every table, separate `USING` / `WITH CHECK`, `(SELECT auth.uid())` wrapping, safely quoted literals |
| RBAC | `definePermissions` turns roles and tenants into policies, with write pins on by default |
| Membership helpers | `SECURITY DEFINER` functions with `SET search_path = pg_catalog, public`, EXECUTE revoked from `PUBLIC` / `anon` |
| Triggers | `updatedAt`, soft delete, audit log, `lockColumns` (column freezing) and custom PL/pgSQL |
| RPCs | Typed Postgres functions; definer RPCs are kept off `anon` unless you opt in |
| Typed SDK | `types.ts` + `client.ts` wrapping `supabase-js` with per-table accessors |

A table without policies is **deny-all** for the API (fail closed). `push` applies the SQL, tracks what was applied, and refuses stale output, edited migrations and unconfirmed data loss.

## Who it is for

- **Supabase projects** that want access rules reviewed as code instead of scattered across SQL files.
- **Teams who rarely read SQL.** The schema reads like a permission table; the SQL is still there to audit.
- **AI coding agents** (Claude Code, Cursor, Codex and others). Most AccessNexus users drive it through an agent, so the package ships an agent reference (`llms.txt`), `init` writes instructions into `AGENTS.md`, every command is non-interactive without a TTY, accepts `--json` and returns stable error codes with a fix hint. See [Built for AI coding agents](/guide/ai-agents).

## Compared with the alternatives

| | SQL by hand | Drizzle `pgPolicy` | AccessNexus |
| --- | --- | --- | --- |
| Where rules live | Migration files | Next to the Drizzle table, in TypeScript | Next to the table, in TypeScript |
| How a rule is written | Raw SQL | Raw SQL expressions passed to `using` / `withCheck` | Semantic builders (`policy.isOwner`, `belongsTo`, `definePermissions`) compiled to SQL; `policy.custom` as an escape hatch |
| `(SELECT auth.uid())` wrapping | You remember it | You write it (or use a helper) | Always emitted; `validate` warns on a bare call in custom SQL |
| Membership checks without RLS recursion | You write the `SECURITY DEFINER` function | You write the `SECURITY DEFINER` function | Generated, hardened and revoked from `anon` |
| UPDATE `WITH CHECK` | Easy to forget | Explicit per policy | Always emitted with the same rule |
| Static security checks | None | None for policy semantics | `validate`: unknown columns, open writes, user-row impersonation, cross-tenant parents, and more |
| Column freezing (RLS is row-level) | Hand-written trigger | Hand-written trigger | `trigger.lockColumns` |
| Typed client | `supabase gen types` | Drizzle query builder (server-side connection) | Generated SDK over `supabase-js` (runs as the signed-in user) |

Drizzle is a full ORM and migration tool; AccessNexus only covers the schema, the access layer and a thin client. Pick based on what you need, not on this table alone.

## When not to use it

- **You are not on Supabase.** Only the Supabase adapter exists. The generated SQL relies on `auth.uid()`, `auth.jwt()` and the `anon` / `authenticated` roles. Firebase support is planned, not available.
- **Your schema needs objects AccessNexus does not model**: views, materialized views, partitioning, extensions or custom composite types. You would manage those outside it.
- **You want hand-tuned SQL for every migration.** Migrations are generated from snapshot diffs; renames are detected heuristically. You can read and review every file, but you do not author them.
- **Your existing columns come only from Supabase types and you also want DDL.** [Database mode](/guide/schema#database-mode) generates RLS, triggers, RPCs and the SDK, but no migrations.

See [Limits](/guide/limits) for the full list.

## Next steps

- [Quick start](/guide/quick-start) - install, define an owner-only table, generate and push
- [How it works](/guide/how-it-works) - the pipeline from schema to SQL and SDK
- [Built for AI coding agents](/guide/ai-agents) - the agent workflow and contract
- [Adopting an existing project](/guide/existing-project) - import tables and policies from a live database
