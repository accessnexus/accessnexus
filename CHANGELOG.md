# Changelog

All notable changes to `accessnexus` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-10-29

### Security

- `push` no longer leaves foreign RLS policies in place silently. It reads `pg_policies` for
  every table the schema manages and refuses with the new `FOREIGN_POLICIES` error (exit 1,
  nothing applied) while any policy there is not named `<prefix>_<table>_<op>`: Postgres ORs
  permissive policies, so an imported project's original policies kept granting access next
  to the generated ones. The new `--replace-foreign-policies` flag drops them in the push
  transaction (`droppedPolicies` in `--json`); `push --dry-run` lists them (`foreignPolicies`,
  `wouldRefuse`) when a database URL is set.
- `push` no longer creates `public.uuid_generate_v7()`, which returned a random v4 UUID and was
  callable by `anon` through PostgREST. The only UUIDv7 helper is `public.accessnexus_uuidv7()`
  (a real RFC 9562 v7), now with EXECUTE revoked from `PUBLIC` and `anon` (granted to
  `authenticated` and `service_role`, and to `anon` only when a v7 table accepts anonymous
  inserts). Databases pushed with 0.1.0 may still have the old function: check that no column
  default uses it, then `DROP FUNCTION public.uuid_generate_v7();`. Already-applied migrations
  are immutable, so an existing `accessnexus_uuidv7()` keeps its grants: run
  `REVOKE EXECUTE ON FUNCTION public.accessnexus_uuidv7() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.accessnexus_uuidv7() TO authenticated, service_role;`.

### Fixed

- `push` is atomic: migrations, policies, triggers, RPCs, the `accessnexus_migrations`
  bookkeeping and foreign-policy drops run in one transaction (still under the advisory lock).
  A failure anywhere rolls back the whole push; `PUSH_FAILED` now reports `applied: []`,
  `rolledBack` (the files that had run) and `failed` (the file Postgres rejected). Failed
  attempts are no longer recorded as `success = false` rows. Limit: a migration cannot use an
  enum value added earlier in the same push (Postgres forbids it in a transaction).
- `uuidGeneration: 'v7'` now also applies to tables added in a `__changes` migration (they got
  `gen_random_uuid()`), and that migration defines the helper before the table.
- `push` and `seed` accept `--db-url` as an alias of `--url` (the flag `init` uses); passing
  both with different values is `INVALID_FLAG_VALUE`.

### Fixed (init --db-url)

- `init --db-url` imports user triggers as `trigger.custom` (timing, events, `FOR EACH`,
  `WHEN`, `SECURITY DEFINER` and the function body kept; `UPDATE OF` becomes a `WHEN`).
  Triggers it cannot express (arguments, disabled, `INSTEAD OF`, `TRUNCATE`-only,
  non-plpgsql) are left as `// WARNING:` comments instead of being dropped silently.
- `validate` accepts names with one leading underscore (`_pix_crc16`) for RPCs, tables and
  columns (`INVALID_IDENTIFIER` rejected functions that `init` had imported).
- RPC parameter defaults are imported and emitted: `args: { p_limit: { type: 'int',
  default: '20' } }` → `p_limit INTEGER DEFAULT 20` (optional in the client types), so
  `CREATE OR REPLACE` works on functions that have defaults. `validate` reports
  `INVALID_DEFAULT` for an argument without default after one with a default.
- Column defaults are imported (`now()`, `0`, `gen_random_uuid()`, ...); `nextval` becomes
  `serial`.
- `numeric` / `numeric(p,s)` are kept instead of becoming `double precision` (new column types
  `numeric`, `numeric(p)`, `numeric(p,s)`); enums are imported as `enum(...)`, `text[]` /
  `int[]` / `uuid[]` arrays keep their type, and unknown types are flagged.
- Foreign keys to other schemas (`auth.users`) are imported, with their `ON DELETE`.
- Composite primary keys are imported as the new `compositePrimaryKey: ['a', 'b']` table
  option (emits `PRIMARY KEY (a, b)`; `validate` reports `INVALID_PRIMARY_KEY` for misuse),
  and composite UNIQUE constraints as unique `indexes` instead of per-column `unique`.
- `init --db-url` no longer prints `DeprecationWarning: Calling client.query() when the client
  is already executing a query`: catalog queries run one at a time.
- A `trigger.custom` body that has its own `DECLARE` / `BEGIN ... END` block is emitted as is.

### Docs

- Existing project guide: a safe first push that reviews and replaces the foreign policies.
- Limits: `diff` compares against the snapshot, not the live database (`diff --against-db` is
  planned).

## [0.1.0] - 2026-10-29

First public release.

### Schema engine

- `defineSchema` / `table` in two modes: manual (explicit `columns`) and Database mode
  (columns from a Supabase-generated `Database` type).
- Generates versioned migrations (`<timestamp>__init.sql` / `__changes.sql` with a
  `.snapshot.json`), RLS policies, triggers, RPCs and a typed SDK (`createAccessNexusClient`).
- `policy.*` builders: `isAuthenticated`, `public`, `none`, `isOwner`, `hasRole`, `belongsTo`,
  `matchesField`, `custom`, `any`, `all`, `withCheck`.
- `definePermissions`: centralized RBAC with multi-tenant scoping (`{ scope: 'tenant', roles }`).
- `trigger.*`: `updatedAt`, `softDelete`, `auditLog`, `lockColumns` (RLS is row-level; this
  freezes columns or limits which ones a user may change), `custom` (invoker or definer);
  `rpc()`; `defineSeed`; `defineConfig` (including `targets` for `--target`).
- Foreign keys accept `onDelete` (`'cascade' | 'set null' | 'restrict' | 'no action'`), per
  column or as a table map; the default stays `NO ACTION`.
- `definePermissions` is typed by its resources: `policiesFor('taks')` is a type error.

### Secure by default (RLS)

- Removing a rule revokes it: each policy file drops the policies of operations that are no
  longer in the schema (or of tables with no `policies`), so the next `push` removes them.
- `(SELECT auth.uid())` initPlan wrapping, `ENABLE` + `FORCE ROW LEVEL SECURITY`, separate
  `USING` / `WITH CHECK`; UPDATE policies always carry an explicit `WITH CHECK`.
- Fail closed: every table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`; a table without
  `policies` is deny-all for the API (`NO_POLICIES` warning). Only an explicit
  `enableRLS: false` leaves a table open (`RLS_DISABLED` warning); `init --db-url` writes it
  for tables whose RLS is off in the database, so adopting a project changes nothing silently.
- `policy.belongsTo(col)` without `through` (lookup in `profiles.<col>`) is rejected by
  `validate` (`BELONGS_TO_PROFILE_WRITABLE`) while users can write that profile column.
- `policy.withCheck(using, check)` requires the written row to pass both rules
  (`{ mode: 'replace' }` to check only the second).
- `definePermissions` pins writes: `create` requires `ownerColumn = auth.uid()`
  (`pinOwnerOnCreate`), and `create` / `update` keep rows inside a tenant the user belongs to
  (`pinTenant`).
- `policy.hasRole` and permission role arrays read the server-controlled JWT
  `app_metadata.role` claim, never the Postgres `role` claim.
- Membership checks compile to `SECURITY DEFINER` helpers with
  `SET search_path = pg_catalog, public` (no RLS recursion) and EXECUTE revoked from
  `PUBLIC` / `anon`.
- Audit-log and soft-delete trigger functions run as `SECURITY DEFINER` with schema-qualified
  targets, so audit tables stay closed to API inserts. A guard rejects plain UPDATEs of the
  soft-delete column by API users, so only DELETE (and its policy) can soft-delete a row; the
  SDK's `delete()` issues a real DELETE.
- A `select` policy is granted `TO public` when a branch can pass without a user (public-read
  tables really are readable by anonymous visitors); writes are `TO public` only for an
  explicit `policy.public()`.
- `security: 'definer'` RPCs get `REVOKE EXECUTE ... FROM PUBLIC, anon` (opt back in with
  `allowAnon: true`).
- `init --db-url` imports policies fail-closed: it keeps each policy's roles (a `TO
  service_role` policy is not opened to everyone), AND-s RESTRICTIVE policies, skips anon-only
  policies with a TODO and maps "RLS on, no policy" to `policy.none()`.
- Every interpolated string literal is quoted; reserved SQL keywords are rejected as names.

### Built for AI coding agents

- `llms.txt` ships in the package: full API with typechecked examples, the agent workflow,
  recipes (owner-only, public read, multi-tenant with roles, child of a tenant resource,
  column-scoped updates, audit log), RLS rules and
  troubleshooting by error code.
- `accessnexus init` writes an idempotent `<!-- accessnexus:start -->` block into the project's
  `AGENTS.md` (and a pointer in `CLAUDE.md`); `--no-agents` skips it.
- Every command is non-interactive without a TTY; `init --yes` plus flags (`--src`, `--sdk`,
  `--prefix`, `--db-url`, `--no-introspect`, `--install`, `--force`) for full automation.
  `init` works in any Node project (Next.js, Vite, CRA, or plain Node), and `init --yes` in an
  empty folder creates a minimal `package.json`. Its next steps print real import specifiers,
  and the client wrapper it writes is marked as the user's file to edit.
- The documented agent workflow is `validate → diff → generate → push --dry-run → push`.
- `--json` on every command prints exactly one JSON object; exit codes `0` ok, `1`
  user-fixable, `2` internal. Colors are off when not a TTY or with `NO_COLOR`.
- Errors carry a stable `code`, a message and a `Fix:` hint; stack traces only with
  `--verbose` / `DEBUG=accessnexus`. Unknown commands and flags fail with a did-you-mean.
- `validate` runs static checks (unknown tables/columns in policies, triggers, references and
  indexes; wrong column types; reserved names; non-uuid owner columns; audit table mismatches;
  global roles mixed with tenant checks; tables without RLS; bare `auth.uid()` in custom SQL and
  RPC bodies; bare-word defaults `INVALID_DEFAULT`; `INVALID_ON_DELETE`;
  `CASCADE_INTO_SOFT_DELETE`; `DUPLICATE_TRIGGER`; misspelled table options or tables nested
  under `tables:` `UNKNOWN_TABLE_KEY`; role typos in `belongsTo` `where` `INVALID_ENUM_VALUE`;
  writes open to anon `PUBLIC_WRITE`;
  user-keyed tables anyone can insert into `USER_ROW_INSERT_OPEN`; tenant lookups through a
  user-writable profile column `BELONGS_TO_PROFILE_WRITABLE`; child rows that can point into
  another tenant `TENANT_PARENT_UNCHECKED`; tables without policies `NO_POLICIES`).
- `help --json` and `<command> --help --json` print the help as one JSON object.
- Database connections (`push`, `seed`, `init --db-url`) time out after 10 s with
  `DB_CONNECTION_FAILED` instead of hanging (`ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds>`).
- `--output <dir>` puts every output folder under `<dir>`, even when `accessnexus.config.ts`
  sets per-folder paths.

### CLI safety

- `push` refuses generated SQL that is out of date with the schema, refuses pending
  migrations that drop tables/columns or change column types without `--allow-destructive`,
  re-applies changed policy/trigger/RPC files safely, refuses a role without `BYPASSRLS`
  (`PUSH_ROLE_NO_BYPASSRLS`, needed by the SECURITY DEFINER helpers), and reports when it
  waits for another push's lock.
- `init --db-url` without the `pg` driver reports `PG_DRIVER_MISSING` (`npm install -D pg`).
- The seed never runs implicitly (`push --seed` or `accessnexus seed`); seeded `auth.users` get
  a random password (`ACCESSNEXUS_SEED_PASSWORD` to choose one); seeding hosted Supabase requires
  `--allow-remote-seed`.
- `diff --check` for CI; `diff` prints only changed hunks and ignores the `Generated at:` line.
- Schema, config and seed files are bundled with esbuild (a dependency), so Node >= 20,
  TypeScript-only syntax and extensionless imports all work.

### Reference example

- `examples/fullstack-saas.schema.ts` closes the holes found in review: managers cannot take
  over an org through `owner_id` (admin-only update, column locked, first admin added by a
  definer trigger instead of a replayable bootstrap rule), profiles are insert-own and visible
  to org mates only, tasks/comments cannot point at another org's rows, reporters/authors are
  frozen, assignees change only status/position, and `accept_invitation` wraps auth calls and
  rejects anon. Joining an org needs consent: memberships are created only by the owner
  trigger and `accept_invitation` (which also requires a confirmed email), so nobody can add
  a stranger to their org to read their profile; orgs are visible to their members only.
  Every attack is replayed by the integration test.

[0.1.0]: https://github.com/accessnexus/accessnexus/releases/tag/v0.1.0
