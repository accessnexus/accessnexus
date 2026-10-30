<p align="center">
  <img src="assets/logo.png" alt="AccessNexus" width="120">
</p>

# AccessNexus

> **The missing schema layer for Supabase.** Define your schema and access rules in
> TypeScript — AccessNexus generates migrations, RLS policies, RBAC, triggers, RPCs, and a
> typed client SDK.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/accessnexus.svg)](https://www.npmjs.com/package/accessnexus)
[![Node.js](https://img.shields.io/badge/node-20%2B-brightgreen.svg)](https://nodejs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-native-3ECF8E.svg)](https://supabase.com/)

AccessNexus is a **schema-first engine for Supabase**. You describe your tables, permissions,
triggers and RPCs once, in typed TypeScript, and AccessNexus compiles that into the SQL your
database actually needs — including the hard part: **correct, performant Row-Level Security**.

> Package name: **`accessnexus`** (brand: *AccessNexus*).

---

## Why?

Row-Level Security is where most Supabase apps get breached or slowed down:

- **RLS is hard** — verbose SQL, subtle traps (recursion, `search_path`, per-row `auth.uid()`),
  no type-safety.
- **No single source of truth** — policies scattered across migrations, drifting from the code.
- **Runtime failures** — an RLS mistake only surfaces when a user (or an attacker) hits it.

AccessNexus fixes all three: one declarative schema generates everything, with the security and
performance best practices baked in.

## What it generates

From a single `accessnexus.schema.ts`:

- ✅ **RLS policies** — `USING`/`WITH CHECK` split (UPDATE always gets an explicit `WITH CHECK`),
  `ENABLE` + `FORCE ROW LEVEL SECURITY` on every table (no policies = deny-all, fail closed),
  safely quoted literals, and the `(SELECT auth.uid())` initPlan optimization.
- ✅ **RBAC** — centralized, multi-tenant role rules via `definePermissions`, with writes pinned
  by default (creators can't impersonate owners, rows can't move to another tenant).
- ✅ **`SECURITY DEFINER` helper functions** — hardened with `SET search_path`, used to break
  RLS recursion on self-referential membership checks.
- ✅ **Triggers** — `updatedAt`, soft-delete and audit log (as hardened `SECURITY DEFINER`
  functions; only DELETE can set the soft-delete column), `lockColumns` (RLS is row-level —
  this freezes owner/tenant columns or limits which columns a user may change), and fully
  custom PL/pgSQL (invoker or definer).
- ✅ **RPCs** — typed PostgreSQL functions (`plpgsql` or `sql`, `invoker`/`definer`); definer
  RPCs are kept off `anon` unless you opt in.
- ✅ **Migrations** — versioned, timestamped DDL with a `.snapshot.json` (hash-based diffing).
- ✅ **Typed SDK** — a client typed from your schema.
- ✅ **UUIDv7** — optional time-ordered UUID PKs (`public.accessnexus_uuidv7()` helper, a real RFC 9562 v7; not callable by `anon`).

## Two ways to define a schema

- **Manual mode** — declare columns explicitly with `table({ columns: … })`.
- **Database mode** — if you already have Supabase-generated `database.types.ts`, reference the
  `Database` type and skip redefining columns. (Mode is auto-detected: Database mode when no
  table declares `columns`.)

## Requirements

- Node.js **20+**
- A Supabase / PostgreSQL database
- `@supabase/supabase-js` — optional peer dependency, needed by the generated SDK
- `pg` — optional peer dependency, needed only by `push`/`seed`

`accessnexus.schema.ts`, `accessnexus.config.ts` and `accessnexus.seed.ts` are bundled with esbuild (a
dependency of `accessnexus`), so TypeScript features and extensionless imports work on every
supported Node version — no `tsx`/`ts-node` needed.

## Install

```bash
npm install -D accessnexus            # CLI + builders
npm install @supabase/supabase-js   # used by the generated SDK
npm install -D pg                   # only if you use push / seed
```

## Quick start

### 1. Initialize (optional)

```bash
npx accessnexus init          # interactive
npx accessnexus init --yes    # non-interactive (CI, AI agents)
```

`init` works in any Node project. It detects Next.js (app/pages router), Vite (React, Vue,
Svelte, ...) and CRA to write matching client wrappers (anything else gets a plain Node
client), offers to install
Supabase deps, and introspects your database. With a **database URL** it imports everything —
tables, exact column types and defaults, PK/FK (composite keys, `auth.users` references),
**RLS policies** (`pg_policies`, keeping each policy's roles and
PERMISSIVE/RESTRICTIVE kind, never granting more than the database did), **functions**
(`pg_proc`, with parameter defaults) and **triggers** (as `trigger.custom`; what cannot be
expressed is left as a `// WARNING:` comment) — via a direct Postgres connection; with only a project **URL + secret key** it imports tables/columns/
PK/FK from the PostgREST **OpenAPI** spec (RLS is not exposed over REST). It also detects an
**existing Supabase client** in your project and wraps it instead of creating a second one,
scaffolds `accessnexus.schema.ts` and `accessnexus.config.ts`, writes framework client wrappers, adds a
`accessnexus` npm script, and writes agent instructions into `AGENTS.md`. In an empty folder,
`init --yes` first creates a minimal `package.json`. The client wrapper it writes (`index.ts`,
or `server.ts`/`browser.ts` on Next.js) is yours to edit; `generate` only rewrites `client.ts`
and `types.ts`.

### 2. Define your schema (manual mode)

```typescript
// accessnexus.schema.ts
import { defineSchema, table, policy, trigger } from 'accessnexus';

export default defineSchema({
  profiles: table({
    // Public profile: any signed-in user can read it, so no private data here
    // (the email already lives in auth.users).
    columns: {
      id: 'uuid',
      name: 'text',
      bio: 'text?',                                    // nullable
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { id: 'auth.users.id' },
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isAuthenticated(),
      insert: policy.isOwner('id'),                    // each user creates only their own row
      update: policy.isOwner('id'),
      delete: policy.none(),
    },
  }),

  posts: table({
    columns: {
      id: 'uuid',
      author_id: 'uuid',
      title: 'text',
      status: "enum('draft','published')",
      published: { type: 'boolean', default: 'false' },
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { author_id: 'profiles.id' },
    softDelete: 'deleted_at',                          // DELETE becomes an update
    policies: {
      // soft-deleted rows stay readable through RLS: keep them out of the public branch
      select: policy.any([policy.isOwner('author_id'), policy.custom('published = true AND deleted_at IS NULL')]),
      insert: policy.isOwner('author_id'),             // signed in AND writing as themselves
      update: policy.isOwner('author_id'),
      delete: policy.isOwner('author_id'),
    },
  }),
});
```

### 3. Review and generate

```bash
npx accessnexus validate   # static checks (unknown columns, open writes, bad defaults...)
npx accessnexus diff       # the SQL that would change — run it before generate
npx accessnexus generate
```

Outputs (default base `./generated`, dirs configurable in `accessnexus.config.ts`):

```
generated/
  migrations/     # <timestamp>__init.sql / __changes.sql + .snapshot.json
  policies/       # <table>_rls.sql
  triggers/       # <table>_triggers.sql
  rpcs/           # rpcs.sql
  sdk/            # types.ts + client.ts
```

### 4. Apply

```bash
npx accessnexus diff --against-db  # what push would REALLY change in the live database
npx accessnexus push --dry-run     # files + the same live plan (when a DB URL is set)
npx accessnexus push               # apply generated SQL to the database
```

`diff --against-db` rehearses the push in a transaction that is rolled back: it snapshots the
catalog of the managed tables and functions, applies exactly what `push` would, snapshots again
and lists every added/removed/modified table, column, policy, trigger, function and grant
(`before → after`), plus `riskyChanges` (function volatility or `search_path` changes, widened
policy roles, dropped policies, lost defaults, type changes, RLS disabled). Nothing persists.

`push` refuses to run when the generated SQL is out of date with the schema, and refuses
pending migrations that drop tables/columns or change column types unless you pass
`--allow-destructive`. It runs as the `postgres` user of your connection string (a role with
`BYPASSRLS`, which the generated `SECURITY DEFINER` helpers rely on; `push` checks this and
fails with `PUSH_ROLE_NO_BYPASSRLS` otherwise). The whole push runs in one transaction: if any
file fails, nothing from that push stays applied. If a table the schema manages already has
RLS policies AccessNexus did not generate (an existing project), `push` refuses with
`FOREIGN_POLICIES` and lists them — Postgres ORs permissive policies, so they would keep
granting access. Review them, then `push --replace-foreign-policies` drops them in the same
transaction. Seeds run only with `accessnexus seed` or `push --seed`.

## Using the generated SDK

The client is a factory: pass in a Supabase-shaped transport (`provider`) and get typed,
per-table accessors. It does not replace `supabase-js` — it wraps it.

```typescript
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './generated/sdk/client.js'; // or your output.sdk folder

const db = createAccessNexusClient(createClient('https://xyz.supabase.co', 'public-anon-key'));

export async function demo(uid: string, id: string) {
  await db.profiles.findMany({ /* filter */ });
  await db.profiles.findById(uid);
  await db.posts.create({ title: 'Hello', author_id: uid, status: 'draft' }); // id, published, deleted_at optional
  await db.posts.update(id, { status: 'published' });
  await db.posts.delete(id);      // a real DELETE; on soft-delete tables the trigger sets deleted_at
  return db.auth;                 // passed straight through from the provider
  // RPCs declared in the schema are typed under db.rpc.<name>(args)
}
```

`<Table>Create` types make nullable columns, columns with a default and auto-generated
(uuid/bigint) primary keys optional. Relations declared via `references` expose a typed
`include` option on `findMany`/`findById`; soft-delete tables auto-filter `deleted_at IS NULL`
on reads (RLS itself does not hide soft-deleted rows — add `policy.custom('deleted_at IS NULL')`
to `select` if raw API reads must not see them).

## Centralized RBAC (multi-tenant)

Define roles and tenant once, then attach per table:

```typescript
import { definePermissions } from 'accessnexus';

const permissions = definePermissions({
  roles: ['admin', 'manager', 'member', 'viewer'],
  tenant: {
    table: 'org_members',
    userColumn: 'user_id',
    tenantColumn: 'org_id',
    roleColumn: 'role',
  },
  resources: {
    projects: {
      ownerColumn: 'created_by',
      tenantColumn: 'org_id',
      read: { scope: 'tenant' },                                   // any org member
      create: { scope: 'tenant', roles: ['admin', 'manager'] },
      update: { any: ['own', { scope: 'tenant', roles: ['admin', 'manager'] }] },
      delete: { scope: 'tenant', roles: ['admin'] },               // org admins
    },
  },
});

// on the table:  policies: permissions.policiesFor('projects')   (typed: only declared resources)
// single rule:   permissions.can('projects', 'update')
```

Permission levels: `'public'`, `'*'` (any authenticated), `'none'`, `'own'`,
`{ scope: 'tenant' }`, `{ scope: 'tenant', roles: [...] }` (roles **inside** the org, from
`tenant.roleColumn`), `{ any: [...] }`, and a role array like `['admin']` — a **global** app role
read from the JWT `app_metadata.role` claim (set server-side), not an org role. Actions map
`read→SELECT`, `create→INSERT`, `update→UPDATE`, `delete→DELETE`. Writes are pinned by default:
`create` requires `ownerColumn = auth.uid()` (`pinOwnerOnCreate: false` to opt out) and
`create`/`update` keep the row in a tenant the user belongs to (`pinTenant: false`). AccessNexus
generates the membership-checking `SECURITY DEFINER` functions (EXECUTE revoked from `anon`) and
wires them in — including the recursion-safe path for the join table itself.

## Policy builders (`policy.*`)

| Builder | Predicate |
| --- | --- |
| `policy.isAuthenticated()` | `(SELECT auth.uid()) IS NOT NULL` |
| `policy.public()` | `TRUE` |
| `policy.none()` | `FALSE` |
| `policy.isOwner('col')` | `(SELECT auth.uid()) = col` |
| `policy.hasRole('admin')` | `((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin'` (global app role) |
| `policy.belongsTo('col', { table, foreignKey, localKey, where? })` | membership via a join table |
| `policy.matchesField('a', 'b')` | `a = b` |
| `policy.custom('sql expr')` | raw SQL predicate |
| `policy.any([...])` | OR of policies |
| `policy.all([...])` | AND of policies |
| `policy.withCheck(using, check)` | `USING (using)`, `WITH CHECK (using AND check)`; `{ mode: 'replace' }` → `WITH CHECK (check)` |

A `select` policy is granted `TO public` when some branch can pass without a user (so
`any([custom('published = true'), isOwner(...)])` really is readable by anonymous visitors);
writes are `TO public` only for an explicit `policy.public()`.

## Triggers, RPCs, columns

- **`trigger.*`** — `updatedAt(col)`, `softDelete(col)` (also auto-added when a table sets
  `softDelete`; a guard rejects plain UPDATEs of the column by API users, so the DELETE policy
  decides soft deletes), `auditLog({ table, columns? })`,
  `lockColumns({ columns | except, unless?, name? })` (BEFORE UPDATE: API users cannot change
  those columns unless the SQL condition holds),
  `custom({ name, events, functionBody, when?, forEach?, security? })`.
- **`rpc(config?)`** — `{ args? (name → type, or `{ type, default }` with a raw SQL default), returns?, body?, language? ('plpgsql'|'sql'), security? ('invoker'|'definer'), allowAnon?, immutable? }`. Marker-only `rpc()` for Database mode; add `body` for full SQL generation. Attach via `defineSchema(tables, { rpcs })`. Definer RPCs get `REVOKE EXECUTE ... FROM PUBLIC, anon` unless `allowAnon: true`.
- **Columns** — scalar strings (`'uuid'`, `'text'`, `'int'`, `'jsonb'`, `'timestamptz'`,
  `'text[]'`, `'numeric(10,2)'`, …), enum via `` "enum('a','b')" ``, nullable by suffixing `?` (`'text?'`), or the
  object form `{ type, default, unique, check, references, onDelete }`. `default` and `check`
  are raw SQL: a string/enum literal needs inner quotes (`default: "'todo'"`); `validate`
  reports `INVALID_DEFAULT` for a bare word.
- **Table options** — `columns`, `primaryKey` (or `compositePrimaryKey: ['a', 'b']`), `references`, `onDelete` (`{ col: 'cascade' |
  'set null' | 'restrict' | 'no action' }`; foreign keys are `NO ACTION` by default),
  `policies`, `triggers`, `enableRLS`, `indexes`, `softDelete`. RLS is enabled and forced on
  every table: a table without `policies` is deny-all for the API (service role only).
  `enableRLS: false` is the explicit opt-out (the table is then open to the anon key).
- **`defineConfig`** (`accessnexus.config.ts`) — `schema`, `seed`, `output.{dir,migrations,policies,triggers,rpcs,sdk}`, `adapter` (default `supabase`), `adapterOptions`, `naming.policyPrefix` (default `accessnexus`), `generate.{sqlOnly,sdkOnly}`, `targets` (for `--target`).
- **`defineSeed`** — manual `defineSeed(schema, data)` or Database-mode `defineSeed<DB>(data)`.
  Users referenced through `auth.users` FKs are created with a random password
  (`ACCESSNEXUS_SEED_PASSWORD` to choose one locally); hosted Supabase needs `--allow-remote-seed`.

## Built for AI coding agents

Most AccessNexus users will drive it through an agent (Claude Code, Cursor, Codex...). The
package is designed for that:

- **[`llms.txt`](https://unpkg.com/accessnexus/llms.txt)** ships in the package (`node_modules/accessnexus/llms.txt`): the
  full API with compiling examples, the agent workflow, recipes, RLS rules and every error
  code. Point your agent at it.
- **`accessnexus init`** writes a marked `<!-- accessnexus:start -->` block into the project's
  `AGENTS.md` (and a pointer in `CLAUDE.md` if present) telling agents the rules: the schema is
  the source of truth, never edit generated SQL, `validate → diff → generate`, dry-run before
  `push`, never `--allow-destructive`/`--seed` without the user's OK. Re-running replaces the
  block in place; `--no-agents` skips it.
- **Never blocks on a prompt**: without a TTY every command runs non-interactively;
  `init --yes` accepts defaults, even in an empty folder (flags: `--src`, `--sdk`, `--prefix`,
  `--db-url`, `--no-introspect`, `--install`, `--force`).
- **`--json`** on every command (including `help --json` and `<command> --help --json`)
  prints exactly one JSON object on stdout (no colors, no progress text). Errors look like
  `{ "ok": false, "error": { "code": "DB_URL_MISSING", "message": "...", "hint": "..." } }`;
  schema problems fail with `error.code: "SCHEMA_VALIDATION_FAILED"` and come back as
  `issues[]` (`{ "code": "UNKNOWN_COLUMN", "path": "posts.policies.update", "hint": "..." }`).
- **Never hangs on the network**: database connections (`push`, `seed`, `init --db-url`) fail
  with `DB_CONNECTION_FAILED` after 10 s (`ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds>`).
- **Exit codes**: `0` success · `1` user-fixable error · `2` internal error (AccessNexus bug).
  Stack traces only with `--verbose` or `DEBUG=accessnexus`.
- **Static checks** (`validate`, also run by `generate`/`diff`/`push`) catch unknown
  tables/columns in policies, wrong column types, reserved SQL keywords as names, non-uuid owner
  columns, audit tables that don't match the audit trigger, global roles mixed with tenant
  checks, bare-word defaults, invalid `onDelete`, writes open to anonymous visitors
  (`PUBLIC_WRITE`), user-keyed tables anyone can insert into (`USER_ROW_INSERT_OPEN`), bare
  `auth.uid()` in custom SQL and RPC bodies, tenant lookups through a user-writable
  `profiles` column (`BELONGS_TO_PROFILE_WRITABLE`), child rows that can point into another
  tenant (`TENANT_PARENT_UNCHECKED`), and tables without policies or with RLS turned off —
  before anything reaches Postgres. Column names inside policies are checked here, not by
  TypeScript, so run `validate` after every schema edit.
- **Guard rails on `push`**: stale generated SQL, data-losing migrations, foreign RLS
  policies on managed tables and a role without `BYPASSRLS` are refused with a clear error
  code (`GENERATED_OUT_OF_DATE`, `DESTRUCTIVE_MIGRATION`, `FOREIGN_POLICIES`,
  `PUSH_ROLE_NO_BYPASSRLS`); a push is one transaction (all or nothing); `generate`/`diff` report `destructive`
  statements in `--json`.

Typical agent loop:

```bash
npx accessnexus validate --json   # fix every issue with severity "error"
npx accessnexus diff --json       # review the SQL that will change (before generate: diff
                                # compares schema vs files on disk); `diff --check` for CI
npx accessnexus generate --json   # created / updated / unchanged per file
npx accessnexus diff --against-db --json   # live plan: review riskyChanges with the user
npx accessnexus push --json                # only when the user asked for it
```

## CLI reference

```
npx accessnexus <command> [flags]        (npx accessnexus <command> --help for details)

Commands:
  init        Set up AccessNexus (schema, accessnexus.config.ts, SDK wrappers, AGENTS.md block)
  generate    Generate migrations, RLS, triggers, RPCs + typed SDK from schema
  diff        Show what generate would change (no writes); --check exits 1 if stale;
              --against-db: what push would change in the live database (rolled back)
  validate    Check the schema for errors without writing anything
  push        Apply generated SQL (refuses stale output and unconfirmed data loss)
  seed        Generate and run the seed against the database
  help        Show help          version   Print the version

Every command:
  --json             One JSON object on stdout (for scripts and agents)
  --verbose          Debug output + stack traces (same as DEBUG=accessnexus)
  --config <path>    Config file (default accessnexus.config.{ts,js,mjs})

generate / diff / validate:
  --schema <path>    Schema file (default: config.schema or ./accessnexus.schema.ts)
  --output <path>    Base output directory (default ./generated)
  --sql-only         Generate only SQL (policies, triggers, RPCs, migrations)
  --sdk-only         Generate only the typed SDK
  --prefix <name>    Policy name prefix (default accessnexus)
  --check            diff only: exit 1 when generated files are out of date
                     (with --against-db: when push would change the database)
diff --against-db:
  --url / --db-url / --adapter / --target   Same database resolution as push
  --allow-destructive, --replace-foreign-policies, --replace-foreign-triggers
                     Plan as push would with these flags

push / seed:
  --url <db-url>        Database URL (alias --db-url)
  --dry-run             Print the plan/SQL without persisting (push: rehearses a live plan when a DB URL is set)
  --adapter <name>      Select adapter when several are configured
  --target <name>       Select a target from config.targets
  --allow-remote-seed   Allow seeding a hosted Supabase project
push only:
  --allow-destructive   Apply migrations that drop tables/columns or change column types
  --seed                Also run the seed after pushing
  --replace-foreign-policies  Drop RLS policies on managed tables that AccessNexus did not generate
seed only:
  --seed <path>         Seed file (default: config.seed or ./accessnexus.seed.ts)

init:
  --yes, -y          Non-interactive (required without a TTY)
  --src <dir>  --sdk <dir>  --prefix <name>  --db-url <url>
  --no-introspect  --install  --force  --no-agents
```

Unknown commands/flags fail with a did-you-mean hint instead of being ignored.

**`push`/`seed` database URL** resolves in this order: `--url` (or its alias `--db-url`) → the adapter's configured env
name (e.g. `dbUrlEnv`) → `ACCESSNEXUS_DB_URL` → `SUPABASE_DB_URL` → `DATABASE_URL`. `push` uses the
`pg` driver, takes an advisory lock (and says so when it has to wait), tracks applied SQL in a
`public.accessnexus_migrations` table (sha256 of the SQL with the timestamp header stripped),
re-applies changed policy/trigger/RPC files, and refuses to proceed on migration drift.
`.env` and `.env.local` are loaded automatically.

## Full example

See [`examples/fullstack-saas.schema.ts`](https://github.com/accessnexus/accessnexus/blob/main/examples/fullstack-saas.schema.ts) — a
multi-tenant project-management SaaS exercising every feature (permissions, policies, triggers,
RPCs, seed, soft delete, enums, references). Its generated output lives in
[`generated/`](https://github.com/accessnexus/accessnexus/tree/main/generated). The recipes in
`llms.txt` cover the same patterns in copy-paste form.

## Project layout

```
src/core/       schema/policy/permissions/trigger/rpc/seed builders + types
src/adapters/   database adapters — currently supabase only (Adapter contract in core/types)
src/cli/        the CLI (init / generate / diff / push / seed / validate)
src/__tests__/  vitest suites — the behavioral contract of the generators and the CLI
examples/       reference schema + seed
generated/      committed generated output
docs/           landing page (index.html)
```

## Development

```bash
npm install                # also builds dist/ (prepare)
npx vitest run             # 19 test files, 322 tests (7 integration tests skipped by default)
npm run typecheck          # src + examples
npm run build              # tsc -> dist/
npm run generate:example   # rebuild and regenerate generated/ from the example schema
```

Integration tests run against a real Supabase Postgres when `ACCESSNEXUS_TEST_DB_URL` is set (see
the header of `src/__tests__/push.integration.test.ts` for the Docker one-liner).

Generator note: SQL headers embed a `Generated at:` timestamp by default, so raw output is not
byte-identical across runs; the **SQL body is stable** and the **migration layer diffs by content
hash** (timestamp stripped), which is what keeps `diff`/`push` from seeing false changes. For
byte-identical output set `adapterOptions.deterministic: true` (omits the timestamp line; this
repo's `accessnexus.config.ts` does). Never hand-edit `generated/` — change the generator and re-run
`generate`.

Contributing to AccessNexus itself with an AI agent? Read
[`AGENTS.md`](https://github.com/accessnexus/accessnexus/blob/main/AGENTS.md) (this repository's contributor guide, not for projects that
use AccessNexus) — notably: **commits carry no AI co-author or attribution.**

## Status

`v0.1.0` — first public release on npm. Only the **Supabase** adapter exists. Ships as a single
package (`accessnexus`). See the [CHANGELOG](CHANGELOG.md).

## License

MIT © The AccessNexus Authors
