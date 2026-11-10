# Changelog

All notable changes to `accessnexus` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.4.2-next] - 2026-11-10

Second round of the field report: what validating 0.4.1-next in the multi-tenant app found.

### Changed

- `migration discard` only discards: it drops the newest migration that no database applied,
  restores the snapshot, and returns `regenerated: null`. The new `migration amend` does
  discard + `generate` and returns the file it wrote in `regenerated`, or `null` when the
  schema matches the restored state. `--no-generate` is gone.
- `test-db` defaults to port 55433, so it no longer collides with the repository's test
  container on 55439. A port already in use fails with `TEST_DB_PORT_IN_USE`.
- The examples import `'accessnexus'` like a real project. In this repository vitest and the
  examples typecheck alias it to `src/`, and the CLI resolves it from where the bundled schema
  runs.

### Added

- Live plan:
  - An index renamed in place (`ALTER INDEX ... RENAME`) shows as one `renamed` change with
    `before.name` / `after.name`, not as removed + added. `summary` gains `renamed`.
  - New risky change `function_result_changed`: an RPC's result type changes, so callers break.
- `tenantInvitations({ tenantNameAlias })`: the column name of the tenant name in
  `my_invitations`, e.g. `'org_name'` to keep the shape of a hand-written RPC.

### Fixed

- `test-db up` on a cold container could fail with `Connection terminated unexpectedly`,
  because the image restarts Postgres after its init. It now waits for 3 consecutive host
  connections (up to 90 s) before preparing the database.
- Warnings and plans named a not-yet-generated migration with a timestamp computed on each run.
  It is now `<pending>__changes.sql`.
- Releases: pre-releases are published with the `next` dist-tag, and `latest` follows them only
  while no stable version exists.

## [0.4.1-next] - 2026-11-10

Fixes and features from a field report (a multi-tenant SaaS built on 0.4.0). Its schema and
RLS suite now ship as `examples/saas-teams/` and `saas-teams.integration.test.ts`.

### Changed (SDK behaviour)

- No more silent denials. `update(id)`, `delete(id)`, `updateOne` and `deleteOne` return
  `error.code === 'ACCESSNEXUS_NOT_FOUND_OR_DENIED'` (`details: { table, method, id | filter }`)
  when no row was changed, whether the row is missing or RLS hides it or denies the write.
  - Before, `delete` reported success, `update` returned a raw `PGRST116`, and `updateOne` /
    `deleteOne` returned `data: null`.
  - `delete(id)` now asks for the affected-row count. On soft-delete tables it checks the live
    row before and after, and `deleteOne` returns the row as it was.
  - React Query mutations throw this error.
  - New exports of `client.ts`: `isNotFoundOrDenied`, `isAccessDenied` (that, or SQLSTATE
    42501), `isLockedColumn` and `NOT_FOUND_OR_DENIED`.
- React Query: the query and mutation of a `RETURNS TABLE` / `SETOF` RPC resolve to `Row[]`, never
  `null`.
- `trigger.lockColumns` raises one error per column: message `<table>.<column> cannot be changed`,
  HINT `accessnexus:locked_column:<table>.<column>`. It is still SQLSTATE 42501.
- Index names come from their content (`idx_<table>_<columns>[_uniq]`) instead of their
  position. Reordering `indexes` generates no DDL, and existing snapshots get a one-time
  migration that renames the indexes (`ALTER INDEX ... RENAME`, never drop and create).
- The foreign-key index (`idx_<t>_<col>_fk`, and the policy-column index) is skipped when a
  declared index starts with that column.

### Added

- Migrations with data:
  - `generate` and `diff` warn `NOT_NULL_COLUMN_ADDED` when a new migration adds a NOT NULL
    column without default to an existing table.
  - The live plan and `push` stop with `NOT_NULL_ON_NON_EMPTY_TABLE` and the row count, instead
    of the raw 23502 error.
  - `riskyChanges` gains `column_nullability_tightened`.
  - `PUSH_WOULD_FAIL` returns the partial plan (`wouldApply`, `changes` up to the failure) and
    `failed.line` / `failed.statement`. When Postgres reports no position, the rehearsal finds
    the statement by replaying the file statement by statement.
  - `migration discard`: drops the newest migration when the database never applied it
    (`MIGRATION_ALREADY_APPLIED`, `MIGRATION_DISCARD_NEEDS_DB`, `--force`), restores the snapshot
    and regenerates. The snapshot now keeps a `history` of earlier states
    (`MIGRATION_HISTORY_MISSING` for older snapshots).
  - `migration data <name>`: creates a data migration `migrations/data/<timestamp>__<name>.sql`.
    Push applies it once, in timestamp order with the schema migrations; push now orders all
    migration files by file name.
- Multi-tenant builders:
  - `tenantInvitations()`: invitations table, policies, `accept_invitation`, `my_invitations`.
  - `defineEnum()` + `defineSchema(..., { enums })`: shared Postgres enums (`'enum:<name>'`),
    usable in RPC args and results.
  - RPC types may also be `'table.column'`.
  - `trigger.keepAtLeastOne`, `trigger.sameTenant`, `trigger.memberOfTenant` and
    `trigger.onAuthUserCreated`.
  - `trigger.custom({ writes })`: React Query mutations then invalidate those tables too.
  - `policy.sharesTenant`, with a SECURITY DEFINER STABLE helper.
  - `definePermissions` levels `{ all: [...] }`.
  - `validate`: `UNKNOWN_ENUM` and checks for every new builder; the `TENANT_PARENT_UNCHECKED`
    hint now suggests `trigger.sameTenant`.
- RLS testing:
  - `accessnexus/testing` exports `asUser`, `asAnon`, `sqlState`, `affectedRows`,
    `expectDenied` (an error or 0 rows) and `TEST_DB_STANDINS_SQL`.
  - `test-db up | down` starts a disposable Supabase Postgres in Docker (`--push` also pushes the
    schema).
  - New error codes: `DOCKER_NOT_FOUND` and `TEST_DB_START_FAILED`.
- `validate --against-db` compiles the generated SQL, including raw policy, trigger and RPC
  bodies, in a rolled-back transaction. A rejection becomes `SQL_REJECTED`, with `path` set to
  the schema item.
- `llms.txt`:
  - An index at the top, with what to read per task.
  - "How a denial shows" (error vs 0 rows) and "Testing RLS".
  - Recipes: a required column on a table with data, the workspace list via memberships, the
    invitee seeing the org name.

### Fixed

- A schema outside the project (`--schema /tmp/x.schema.ts`) could not import `accessnexus`. It
  now falls back to the package the CLI runs from.

## [0.4.0] - 2026-11-10

### Added

- Supabase Edge Functions, from the schema:
  - `edgeFunction({ auth, input, output })` and `defineSchema(tables, { functions })` declare each
    function by name (`'invite-member'`). `auth` is `'user'` (default), `'publishable'`,
    `'secret'`, `'none'` or an array of them (the `withSupabase` modes of `@supabase/server`).
    `input` / `output` use column types (`'uuid'`, `'text?'`, `"enum('a','b')"`,
    `'varchar(20)'`, ...).
  - `generate` writes `supabase/functions/_shared/accessnexus.ts`, which is derived. Each
    function gets a `<camelName>(handler)` wrapper on `withSupabase`. The wrapper rejects callers
    without the required credential and answers CORS. It requires POST and validates the JSON body
    field by field (`400 invalid_input` with `issues`) before calling `handler(input, ctx, req)`,
    where `ctx.supabase` runs as the caller under RLS. It maps the return value to JSON (`204` when
    nothing is returned), `FunctionError` to its status, and any other exception to a generic `500`.
    Without `input`, the raw body is left to the handler, for webhook signatures.
  - `generate` also scaffolds `supabase/functions/<name>/index.ts` once, when the file is missing.
    Generated files may now be marked `overwrite: false`: created when missing, never compared or
    replaced after.
  - `supabase/config.toml`, when it exists, gets a managed block of
    `[functions.<name>] verify_jwt = ...`. It is `false` only when `auth` accepts `'none'`. Tables
    the user already set outside the block are left alone, with a note in the block.
  - New config option `output.functions` (default `./supabase/functions`) and new output category
    `functions`.
  - SDK: `client.functions.<camelName>(input, { headers?, region? })` calls
    `supabase.functions.invoke` with POST, with typed input and output. New exported types
    `<Name>Input`, `<Name>Output` and `FunctionInvokeOptions`. React Query adds
    `q.functions.<name>.query(input)` / `.mutation()`.
  - `validate`: `INVALID_EDGE_FUNCTION` and `TABLE_NAME_CLASH` (errors), and
    `EDGE_FUNCTION_PUBLIC` (warning). `validate --json` adds `functions`.
- Exported types `EdgeFunctionAuth`, `EdgeFunctionDef` and `EdgeFunctionFields`.

## [0.3.0] - 2026-11-10

### Added

- Supabase Realtime, from the schema:
  - Table option `realtime: true` adds the table to the `supabase_realtime` publication,
    `realtime: false` removes it, and leaving it out leaves the publication alone. It works in
    manual and Database mode. `{ replicaIdentity: 'full' }` also sets `REPLICA IDENTITY FULL`.
    Push applies the new idempotent `generated/policies/realtime.sql`. A database without the
    publication gets a warning, not an error.
  - `channel()` and `defineSchema(tables, { channels })` declare private Broadcast / Presence
    channels. Each `receive` / `send` rule becomes an RLS policy on `realtime.messages`
    (`<prefix>_rt_<channel>_<broadcast|presence>_<receive|send>`). The policy is scoped to the
    extension and the topic (`'lobby'` or `'project:{id}'`). With `table`, every rule also
    requires that the user can SELECT the row the topic names, checked as the user, so the
    table's RLS decides; malformed keys are denied without errors. Rules: `true`, `false`,
    `policy.isAuthenticated / public / none / hasRole / custom` (`{param}` placeholder) and
    `any` / `all`. Push drops `<prefix>_rt_*` policies that are no longer declared and never
    touches other policies on `realtime.messages`.
  - SDK: `client.<table>.subscribe(listener, { event?, filter?, onStatus? })` on realtime
    tables returns an unsubscribe function. Changes are typed from the row and narrowed by
    `event`. Filters (one column, as Realtime allows) are typed: value, array (`in`) or
    `{ eq | neq | lt | lte | gt | gte | in }`. `client.channels.<name>(param)` returns the
    provider's private `RealtimeChannel`. New exported types: `RealtimeEvent`,
    `RealtimeChange`, `RealtimeChangeOf`, `RealtimeFilter`, `RealtimeSubscribeOptions`,
    `ChannelOf`. Schemas without Realtime generate the same client as before.
  - React Query: `q.<table>.invalidateOnChange({ event?, filter? })` invalidates a realtime
    table's queries, and those of the tables that embed it, on every change.
  - `validate`: `INVALID_REALTIME`, `INVALID_CHANNEL` and `CHANNEL_RULE_NOT_SUPPORTED`
    (errors); `REALTIME_NOT_READABLE`, `REALTIME_RLS_DISABLED`,
    `REALTIME_REPLICA_FULL_WITH_RLS`, `CHANNEL_TABLE_NOT_READABLE`, `CHANNEL_PUBLIC_SEND` and
    `CHANNEL_CLOSED` (warnings). `validate --json` adds `realtime` per table and `channels`.
  - `init --db-url` imports published tables as `realtime: true` (with `replicaIdentity: 'full'`
    when set). It lists the existing `realtime.messages` policies in the schema and the output
    without importing them.
- Exported types `ChannelDef`, `ChannelAccess`, `ChannelRule` and `TableRealtime`.

## [0.2.1] - 2026-11-10

### Security

- Bump `esbuild` to `^0.28.2` (GHSA for `esbuild >=0.27.3 <0.28.1`: arbitrary file read through
  the development server on Windows). AccessNexus only calls `esbuild.buildSync` to load the
  schema and never starts the server, so it was not exploitable through the CLI; the bump
  clears the `npm audit` warning in projects that install `accessnexus`.

## [0.2.0] - 2026-11-10

### Added

- TanStack Query (React Query) support: `adapterOptions: { reactQuery: true }` makes
  `generate` also write `<sdk>/react-query.ts` (same file in manual and Database mode; needs
  `@tanstack/react-query` v5 in the app, AccessNexus does not depend on it).
  `createAccessNexusQueries(client, { queryClient? })` returns `queryOptions` for
  `findMany` / `findOne` / `findById` on every table (same arguments and generics as the
  client, so `columns` / `include` narrow `data`), mutation options for `create`, `update`,
  `delete`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, and
  `rpc.<name>.query(args)` / `rpc.<name>.mutation()` for every RPC. `queryFn` / `mutationFn`
  throw the Supabase error as-is; lists resolve to `[]`. With `queryClient`, a write
  invalidates its table and the tables that embed it through `include`, and an RPC mutation
  invalidates every AccessNexus query. Keys come from the exported `accessNexusKeys`
  (`['accessnexus', <table>, ...]`).
- `SupabaseAdapterOptions.reactQuery` (default `false`).

### Changed

- Generated `client.ts` now exports the `<Table>Include` types (additive).

## [0.1.6] - 2026-10-30

### Added

- `rpc({ returns: { table: { booking_id: 'uuid', date_time: 'timestamptz', ... } } })` emits
  `RETURNS TABLE(...)` and types the SDK result as rows (`{ booking_id: string; ... }[]`, the
  `supabase gen types` shape; column types map like table columns, `json`/`jsonb` → `Json`).
  `returns: { setof: 'bookings' }` emits `RETURNS SETOF bookings` and types `Row[]` of that
  table; `{ setof: 'uuid' }` gives `string[]`. `validate` reports bad shapes as
  `INVALID_RPC_RETURNS`.
- SDK: `updateOne(filter, patch, { columns? })` / `updateMany(...)` and
  `deleteOne(filter, { columns? })` / `deleteMany(...)` on every table: one round trip
  (`.update(patch).match(filter).select(columns)`, `.maybeSingle()` for the *One variants),
  returning the written rows (`Row | null` / `Row[]`, narrowed by `columns`). The filter is
  required: unknown columns and `{}` do not compile (new exported `RowFilter` type), and an
  empty filter throws before any request, so a mistake never writes the whole table. On a
  softDelete table they only touch live rows, and the delete variants return `null` / `[]`
  (the trigger turns the DELETE into an UPDATE).
- `policies: { all: rule }` applies one rule to select, insert, update and delete; explicit
  per-operation keys override it (`{ all: policy.isOwner('user_id'), delete: policy.none() }`).
  It expands into the usual one policy per operation (never `FOR ALL`), so USING / WITH CHECK,
  policy names, removed-operation drops and every `validate` warning (`PUBLIC_WRITE`,
  `USER_ROW_INSERT_OPEN`, ...) behave as if the keys were written out. Unrelated to the
  `policy.all([...])` combinator, which is unchanged. `definePermissions` resources accept
  `all: <level>` the same way (write pins still apply).

### Fixed

- `init --db-url` imported functions returning `TABLE(...)` / `SETOF ...` as an empty `rpc()`,
  so the SDK typed them `Args: Record<string, never>; Returns: unknown` and correct calls
  such as `rpc.get_client_bookings({ p_client_id })` did not compile. They are now imported
  fully (args, `returns: { table }` / `{ setof }`, body). A function whose result or an
  argument type `rpc()` still cannot express (`record`, composite types, OUT parameters) is
  imported signature-only with its real `args` (a composite argument typed `'json'`), never
  as an argument-less `rpc()`.
- Changing an RPC's result type (scalar, TABLE columns, SETOF) or an argument name made `push`
  fail with "cannot change return type of existing function". Each generated function is now
  preceded by a guard that drops it (no CASCADE) when its result or argument names differ,
  inside the push transaction; an unchanged function is never dropped. If a policy, view or
  function depends on it the push fails and applies nothing — change the dependent first.
  The live plan shows it as a changed function, not a dropped one. `rpcs.sql` changes for
  every RPC with a body (the guard block); regenerate.

## [0.1.5] - 2026-10-30

### Fixed

- The client wrappers `init` writes for Next.js, Vite, CRA and other bundler projects import
  `./client` instead of `./client.js`. Turbopack (`next build`) could not resolve `./client.js`
  to `client.ts`, so the build broke as soon as app code imported a wrapper. Plain Node keeps
  `./client.js` unless its tsconfig uses `moduleResolution: "bundler"`. Wrappers written by an
  earlier `init` are yours: change the import by hand (`generate` never overwrites them).

## [0.1.4] - 2026-10-30

### Added

- SDK: `findOne(filter, options?)` on every table: `.match(filter).maybeSingle()`, returning
  `Row | null` without an error when nothing matches (lookups by `slug`, `email`, ...).
- SDK: `columns` option on `findMany`/`findOne`/`findById`: `{ columns: ['id', 'name'] }` sends
  `select('id, name')` and narrows the result to `Pick<Row, 'id' | 'name'>`. Unknown column
  names are compile errors; it combines with `include`. New exported helper types `ColumnsOf`
  and `SelectedRow`; `AccessNexusProvider` is now exported.
- SDK (manual mode): `types.ts` exports `Json`, identical to the `Json` of `supabase gen types`
  (also re-exported from `client.ts`).

### Changed

- SDK: `auth` keeps the provider's type (`TClient['auth']`) instead of `unknown`, so
  `db.auth.signInWithOAuth(...)` typechecks with `createClient` / `createBrowserClient` /
  `createServerClient`. `AccessNexusClient` takes the provider type:
  `AccessNexusClient<SupabaseClient<Database>>` (the argument is optional).
- SDK: `json`/`jsonb` columns (and RPC args/returns) are typed `Json` instead of
  `Record<string, unknown>`, so rows are compatible with Supabase's generated types (jsonb can
  be an array, string, number, boolean or null). Code that read properties straight off a
  jsonb value now needs a narrowing check.
- SDK: manual-mode row types are type aliases instead of interfaces, so they satisfy
  supabase-js' `GenericTable` and the generated `Database` can be passed to
  `createClient<Database>()`. Interface declaration merging on them no longer works.
- SDK: `findById` uses `maybeSingle()` instead of `single()`: a missing (or RLS-hidden) row is
  now `{ data: null, error: null }` instead of a PGRST116 error. Code that relied on `error`
  to detect "not found" should check `data === null`.
- SDK: `delete(id)` is typed `QueryResult<null>` (supabase-js returns `data: null` for a
  delete without `.select()`).

## [0.1.3] - 2026-10-29

### Fixed

- `push` applies RPCs before policies and triggers (migrations → rpcs → policies → triggers).
  On a fresh database a policy calling an `rpc()` helper failed because the function did not
  exist yet.
- `init --db-url` no longer takes `anon` away from definer functions. It emitted
  `rpc({ security: 'definer' })` without `allowAnon`, so `push` revoked `anon` from every
  SECURITY DEFINER function anon could execute (directly or via `PUBLIC`): `TO public`
  policies calling such a helper made anonymous SELECTs fail with "permission denied for
  function" instead of returning 0 rows. init now reads the effective privilege
  (`has_function_privilege` for `anon` and `authenticated`) and emits `allowAnon: true` with a
  `// NOTE:` comment where anon could execute the function; `init --json` lists them in
  `anonExecutableFunctions` (and the human output prints them) so maintenance/admin functions
  exposed to anon get a deliberate decision. A definer function authenticated could not
  execute gets a `// NOTE:` and `authenticatedGrantedFunctions` (`rpc()` always grants
  `authenticated`). Invoker functions keep their grants as before.
- `diff --against-db` judges grants on effective access, not on the ACL's literal shape:
  `grant_widened` is no longer reported when anon already had `EXECUTE` via `PUBLIC`. The grant
  snapshot carries `effective` (PUBLIC / anon / authenticated, via `has_function_privilege` /
  `has_table_privilege`) next to the literal `privileges`, and grant changes carry `notes`
  such as `anon EXECUTE: via PUBLIC → direct grant (no change in access)`.
- `diff --against-db` with `--replace-foreign-triggers` reported the original trigger
  functions as `function_dropped`. They were never dropped (the plan stopped looking at them
  once their trigger was gone); the after-snapshot now covers the same functions.
- Generated SDK passes typescript-eslint `recommended`: `Record<string, never>` for RPCs
  without arguments (`no-empty-object-type`), `unknown` instead of `{}` in the include
  helpers, and no `any` in the provider type. RPCs without arguments can be called as
  `client.rpc.name()`.

### Added

- `grant_narrowed` risk code: `PUBLIC`, `anon` or `authenticated` lose effective access to an
  existing function or table (`PUBLIC` losing a privilege anon and authenticated both keep is
  not flagged).
- `push --replace-foreign-triggers` (and the live plan) return `keptTriggerFunctions`: the
  functions of the dropped triggers, which are never dropped, with what still depends on them
  (`pg_depend`: triggers in any schema, other objects) and `orphaned`. `ForeignTrigger` gains
  `function`.

## [0.1.2] - 2026-10-29

### Added

- `rpc({ volatility: 'volatile' | 'stable' | 'immutable' })`. `immutable: true` still works as
  an alias; a contradicting pair is reported as `RPC_VOLATILITY_CONFLICT`. Declare read-only
  helpers used in RLS policies `'stable'` so Postgres can evaluate them once per query.
- `rpc({ set })` and `trigger.custom({ set })`: function configuration such as
  `{ row_security: 'off' }`, emitted as `SET key = 'value'` (keys validated as GUC names,
  values quoted; `INVALID_FUNCTION_SET` otherwise). `search_path` stays pinned to
  `pg_catalog, public`; a different `set.search_path` is ignored with a `SEARCH_PATH_PINNED`
  warning.
- `init --json` returns `hardenedFunctions`: every imported RPC or trigger function whose
  `search_path` `generate` changes (from another value, or none, to `pg_catalog, public`).

- `diff --against-db`: a live-database change plan. `diff` compared the schema with the
  generated files, so an agent could not see what a push would really change (and found
  regressions such as STABLE → VOLATILE functions or a lost `SET search_path` only after
  pushing). The new mode rehearses the push: it takes the push lock without waiting
  (`PUSH_LOCKED`), BEGINs, snapshots the catalog of the managed tables (columns, defaults,
  constraints, indexes, RLS, policies, triggers, grants) and of the functions the SQL defines
  or the triggers call (volatility, security definer, `proconfig`, body hash), runs the push
  code path, snapshots again and ROLLs BACK — nothing persists, not even
  `accessnexus_migrations` rows. The result lists `changes` (`kind`, `object`, `change`,
  `before`, `after`, `fields`), `riskyChanges` (function volatility/config/security changes,
  widened policy roles, dropped policies/triggers/functions/tables/columns, lost defaults,
  type changes, relaxed `NOT NULL`, RLS disabled, grants widened to `anon`/`PUBLIC`) and the
  `blockers` a real push would stop at. Takes the same `--url`/`--db-url`/env/`--target`
  resolution as `push` and its `--replace-foreign-*` / `--allow-destructive` flags. `--check`
  exits 1 with `LIVE_DB_CHANGES`; a push Postgres would reject exits 1 with `PUSH_WOULD_FAIL`
  (`failed: { file, message, sqlState }`).
- `push --dry-run` runs the same rehearsal on the files on disk when a database URL is set
  and returns it as `livePlan` (`wouldRefuse` also covers its blockers and failures).
- Plain `diff` adds a `hint` pointing to `--against-db` when a database URL is configured.
  The `AGENTS.md` block `init` writes and `llms.txt` tell agents to run
  `diff --against-db --json` (or `push --dry-run --json`) before any push and review
  `riskyChanges` with the user.

### Fixed

- `init --db-url` no longer loses function volatility: `STABLE` / `IMMUTABLE` functions were
  re-created as `VOLATILE` (an issue for helpers used inside RLS policies). They are imported
  as `volatility`.
- `init --db-url` keeps every `SET` option of a function or trigger function
  (`pg_proc.proconfig`, e.g. `row_security = off`) instead of only `search_path`.
- The `search_path` rewrite on import is no longer silent: each affected function gets a
  `// NOTE:` comment in the generated schema and is listed in the init output.

## [0.1.1] - 2026-10-29

### Security

- `push` no longer leaves foreign RLS policies in place silently. It reads `pg_policies` for
  every table the schema manages and refuses with the new `FOREIGN_POLICIES` error (exit 1,
  nothing applied) while any policy there is not named `<prefix>_<table>_<op>`: Postgres ORs
  permissive policies, so an imported project's original policies kept granting access next
  to the generated ones. The new `--replace-foreign-policies` flag drops them in the push
  transaction (`droppedPolicies` in `--json`); `push --dry-run` lists them (`foreignPolicies`,
  `wouldRefuse`) when a database URL is set.
- Same for triggers: after `init --db-url`, an imported trigger and the original would both
  fire (an audit insert or a counter running twice). `push` refuses with `FOREIGN_TRIGGERS`
  while a managed table has a trigger not named `<prefix>_<table>_...`; `--replace-foreign-triggers`
  drops them in the push transaction (`droppedTriggers`).
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
