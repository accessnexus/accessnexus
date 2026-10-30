# Existing projects

You can adopt a Supabase project that already has tables, policies and functions. `init` reads the database and writes an `accessnexus.schema.ts` that reproduces it. You review that file, and the first `push` then changes as little as possible.

## Before you start

```bash
npm install -D accessnexus pg
```

- Get the **Session pooler** connection string (Dashboard, Connect). It connects as `postgres`, which has the `BYPASSRLS` that `push` needs.
- Take a backup, and if you can, rehearse on a staging copy or a branch database first.

## Run `init`

```bash
npx accessnexus init --yes --db-url "$SUPABASE_DB_URL"
```

### Framework detection

| Detected from `package.json` | Wrapper files written to the SDK folder |
| --- | --- |
| `next` with an `app/` (or `src/app/`) folder | `server.ts` + `browser.ts` (App Router, `@supabase/ssr`) |
| `next` without `app/` | `server.ts` + `browser.ts` (Pages Router) |
| `vite` + `react`, `vite` alone, `react-scripts`, other React | `index.ts` |
| anything else | `index.ts` (plain Node client) |

### Reusing your Supabase client

`init` looks for an existing client in `src/` and the project root: `lib/supabase/server`, `utils/supabase/server`, `lib/supabase-server` (server side) and `lib/supabase/client`, `utils/supabase/client`, `lib/supabase/browser`, `lib/supabaseClient`, `lib/supabase`, `supabaseClient` (browser side), with `.ts`, `.tsx`, `.js` or `.jsx`. It recognizes an exported `createClient` / `createBrowserClient` / `createServerClient` / `createSupabase*` factory, or an exported `supabase`, `client` or `db` instance. When it finds one, the wrapper imports it instead of creating a second client. The wrapper files are yours to edit; `generate` never touches them.

### Where the schema comes from

| `schemaSource` | When | What is imported |
| --- | --- | --- |
| `database` | `--db-url`, or a URL in `ACCESSNEXUS_DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | Tables, exact column types and defaults, keys, RLS state, policies, functions, triggers |
| `rest` | No DB URL, but a Supabase URL and secret key in `.env*` | Tables, columns, primary and foreign keys only |
| `template` | `--no-introspect`, or nothing found | A commented example |

`--db-url` needs the `pg` driver (`PG_DRIVER_MISSING`) and fails with `DB_CONNECTION_FAILED` after 10 s when the host does not answer. With `--no-introspect`, `init` never connects.

::: warning Prefer `--db-url` over the REST import
REST cannot read RLS. The imported tables then have no policies, so the first `push` turns RLS on for all of them. Existing database policies are reported as foreign (see below), and a table whose RLS was off becomes deny-all until you add policies or `enableRLS: false`.
:::

## What is imported

From the `public` schema, using a direct connection:

| Imported | Notes |
| --- | --- |
| Base tables and columns, nullability | System tables such as `spatial_ref_sys` are skipped |
| Column types | Exact where AccessNexus has the type: `numeric(10,2)`, `numeric`, `smallint`, `varchar`, enums as `"enum('a','b')"`, `text[]` / `int[]` / `uuid[]`. Anything else becomes `text` with a `// WARNING:` comment |
| Column defaults | As `default` (`now()`, `0`, `'{}'::text[]`). `serial` / `nextval(...)` becomes `serial`; an enum literal loses its cast to the old type name |
| Primary key | One column as `primaryKey`, several as `compositePrimaryKey: ['a', 'b']` |
| Foreign keys | As `references`, including other schemas (`'auth.users.id'`), with their `ON DELETE` as `onDelete`. Multi-column FKs become a `// WARNING:` comment |
| Unique constraints | One column: `unique: true`. Several columns: `indexes: [{ columns: [...], unique: true }]` |
| RLS on or off | Off becomes an explicit `enableRLS: false` |
| Policies (`pg_policies`) | Translated fail-closed, see below |
| Functions (`pg_proc`) | Not trigger functions, not owned by an extension. Parameter defaults are kept |
| Triggers (`pg_trigger`) | User triggers as `trigger.custom`, see below. Triggers named `<prefix>_...` (made by AccessNexus) are skipped |

### How policies are translated

The import never grants more than the database did:

- Permissive policies for an operation are OR-ed (`policy.any`); RESTRICTIVE ones are AND-ed in (`policy.all`), applied to every API user.
- `FOR ALL` policies are expanded to the four operations.
- Policies for non-API roles (`TO service_role`, ...) are skipped; the service role bypasses RLS anyway.
- `TO authenticated` adds the signed-in requirement.
- A policy granted to `anon` only cannot be expressed: it becomes a `TODO` comment and the operation stays denied.
- RLS on with no policies becomes `policy.none()` for every operation.
- An UPDATE whose `WITH CHECK` differs from `USING` becomes `policy.withCheck(using, check, { mode: 'replace' })`.
- `true`, `false`, `auth.uid() IS NOT NULL` and `auth.uid() = col` become `policy.public()`, `policy.none()`, `policy.isAuthenticated()` and `policy.isOwner('col')`. Everything else is kept verbatim in `policy.custom()`. `auth.jwt() ->> 'role'` is never mapped to `hasRole`, which reads a different claim.

Each rule carries a comment naming its source policy:

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
    },
    primaryKey: 'id',
    policies: {
      // TODO: "anon peek" (PERMISSIVE, SELECT, TO anon) grants anonymous users only, which AccessNexus cannot express — skipped (access denied); add it back by hand if needed
      // from "own notes" (PERMISSIVE, ALL, TO authenticated)
      // "svc" (PERMISSIVE, SELECT, TO service_role): skipped — it does not apply to API users (service_role bypasses RLS anyway)
      select: policy.isOwner('user_id'),
      // from "own notes" (PERMISSIVE, ALL, TO authenticated)
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

### How functions are translated

- Scalar arguments and return type: a full `rpc({ args, returns, language, security, volatility, set, body })`. `STABLE` / `IMMUTABLE` are kept as `volatility`, and every `SET` of the function other than `search_path` (`pg_proc.proconfig`, e.g. `row_security = off`) as `set`. Grants are imported from the **effective** privilege in the source database (`has_function_privilege`, so access through `PUBLIC` counts): a definer function `anon` could execute gets `allowAnon: true` with a `// NOTE:` comment, and `init` lists it (human output, and `anonExecutableFunctions` with `--json`) so a maintenance or admin function exposed to `anon` gets a deliberate decision. Remove `allowAnon` where it should not stay public. A definer function `anon` could not execute stays revoked. `rpc()` always grants `authenticated`; a definer function `authenticated` could not execute gets a `// NOTE:` and is listed in `authenticatedGrantedFunctions`. Invoker functions keep their grants: `push` does not touch them.
- `search_path` is hardened: `push` re-creates every imported function (RPCs and trigger functions) with `SET search_path = pg_catalog, public`. A function that had another `search_path` (e.g. `'public'`) or none gets a `// NOTE:` comment in the schema, and `init` lists it (human output, and `hardenedFunctions: [{ kind, name, from, to }]` with `--json`). Check that its body schema-qualifies anything outside `public` (`auth.users`, `extensions.<fn>`).
- `RETURNS TABLE(...)`, `SETOF <imported table>` (also `SETOF public.x`) and `SETOF <scalar>`: imported fully, as `returns: { table: { ... } }` / `{ setof: '...' }` with args and body.
- Functions it cannot express (result `record`, a composite type or `OUT` parameters, or an argument of a composite type): a signature-only `rpc({ args })` with the real arguments, so the SDK types the call; an argument it cannot map is typed `'json'`, with a comment. The SQL stays in your migrations and the function as it is in the database. A function with no arguments and such a result is still `rpc()`.
- Parameter defaults are kept: `p_limit integer DEFAULT 20` becomes `p_limit: { type: 'int', default: '20' }`, so `CREATE OR REPLACE` matches the existing function (Postgres refuses to replace a function and drop its defaults).
- Names with a leading underscore (`_pix_crc16`) are valid.
- Overloads: only the first is kept; the others become a comment.

### How triggers are translated

Each user trigger becomes a `trigger.custom({ name, events, forEach, when, security, functionBody })` with the body of its function (`pg_proc.prosrc`):

- `BEFORE` / `AFTER`, `INSERT` / `UPDATE` / `DELETE`, `FOR EACH ROW` / `STATEMENT`, the `WHEN` condition, `SECURITY DEFINER` and the function's `SET` options (as `set`) are kept. The function's volatility is not: trigger functions are always created `VOLATILE`, which behaves the same for a trigger. Its `search_path` is hardened as for RPCs.
- `UPDATE OF col` on a row trigger that only handles UPDATE becomes `when: 'OLD.col IS DISTINCT FROM NEW.col'`; otherwise it fires on every UPDATE and a `// WARNING:` says so.
- Not imported, with a `// WARNING:` comment and the original `CREATE TRIGGER`: triggers that pass arguments (`TG_ARGV`), disabled triggers, `INSTEAD OF` and `TRUNCATE`-only triggers, and functions not written in `plpgsql`. A constraint trigger is imported as a regular one, with a warning.

`push` creates the trigger as `<prefix>_<table>_<name>` with its own function. On the same database, the original trigger still exists, so `push` refuses with `FOREIGN_TRIGGERS` until you pass `--replace-foreign-triggers` (see below).

## What to review before the first `generate`

Fix these **before** you run `generate` for the first time. The first migration uses `CREATE TABLE IF NOT EXISTS`, so declarations in it do not touch existing tables. After that, the same edits turn into `ALTER` migrations.

- **`// WARNING:` comments**: each one names something the import could not express (an unknown or array type imported as `text`, a generated column, a multi-column FK, a trigger left out). Fix the type or recreate the object by hand.
- **Enums**: AccessNexus creates its own enum type per column (`<table>_<column>_enum`). On the existing database the column keeps its type; functions that cast to the old type name keep working there, but not on a fresh database.
- **Lengths and precision AccessNexus has no type for**: `varchar(20)` becomes `varchar`, `real` becomes `float` (a comment says so).
- **Not imported**: `CHECK` constraints, non-unique indexes, views. They stay in the database; add them to the schema if you want them tracked.
- **Policies in `policy.custom()`**: replace with semantic builders where possible, and wrap auth calls (`validate` warns `UNWRAPPED_AUTH_CALL`).
- **`TODO` comments** for anon-only policies, and every `enableRLS: false`.

Then run `npx accessnexus validate` until it is clean.

## The safe first push

After `init`, the original policies are still in the database. Postgres ORs permissive policies, so an original policy would keep granting access next to the generated ones, whatever the schema says. `push` therefore never keeps them silently, and never drops them silently either: it reads `pg_policies` for every table the schema manages and refuses with `FOREIGN_POLICIES` while any policy there is not named `<prefix>_<table>_<op>`.

1. `npx accessnexus generate`, then read what it wrote:
   - `__init.sql`: `CREATE TABLE IF NOT EXISTS` (no-op for existing tables), `CREATE INDEX IF NOT EXISTS` on foreign-key and policy columns (new indexes), enum types if missing.
   - `policies/*.sql`: `ENABLE` + `FORCE ROW LEVEL SECURITY` and policies named `<prefix>_<table>_<op>`.
   - `triggers/*.sql`: the imported triggers, as `<prefix>_<table>_<name>`.
   - `rpcs.sql`: `CREATE OR REPLACE` of the imported functions.
2. `npx accessnexus push --dry-run --json` with the database URL set: `destructive` must be empty, and `foreignPolicies` lists every original policy on a managed table (`wouldRefuse: true`). The dry run only reads.
3. Compare each listed policy with the rule `init` generated for it (each rule has a comment naming its source policy). Port anything still missing into `accessnexus.schema.ts`, then `generate` again.
4. On staging: `npx accessnexus push --replace-foreign-policies`. In one transaction it drops the listed policies (`droppedPolicies` in `--json`), applies the migrations, the generated policies, triggers and RPCs, and records them. If anything fails, all of it is rolled back, including the drops: the database is left as it was.
5. Test the app as real users (anon, signed in, other tenants). Then repeat steps 2 and 4 on production.

After this push, only the generated policies exist on the managed tables, so the schema is the source of truth.

::: danger Drop the originals only after review, and with consent
`--replace-foreign-policies` deletes policies AccessNexus did not write. Pass it only after step 3. If an agent is driving, it must show the `FOREIGN_POLICIES` list and ask before passing the flag.

Imported triggers work the same way: the original would fire next to its generated copy (an `updated_at` touch is harmless twice, an audit insert or a counter is not), so `push` refuses with `FOREIGN_TRIGGERS` and lists them. Once the imported `trigger.custom` entries are reviewed, `npx accessnexus push --replace-foreign-triggers` drops the originals in the same transaction. It drops the triggers only, never their functions: a function can still be used by a trigger outside the managed tables (e.g. on `auth.users`) or by another object. The result lists each one in `keptTriggerFunctions` with what still depends on it (`pg_depend`); `orphaned: true` means nothing does and you can drop it by hand after review. Calls from other function bodies are not tracked by Postgres, so check before dropping.

If an agent is driving, it must ask before dropping anything.
:::

## Related

- [CLI](/guide/cli): `init` flags
- [Security model](/guide/security)
- [Troubleshooting](/guide/troubleshooting)
- [Limits & roadmap](/guide/limits)
