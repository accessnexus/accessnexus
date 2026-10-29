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
| `database` | `--db-url`, or a URL in `ACCESSNEXUS_DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | Tables, columns, keys, RLS state, policies, functions |
| `rest` | No DB URL, but a Supabase URL and secret key in `.env*` | Tables, columns, primary and foreign keys only |
| `template` | `--no-introspect`, or nothing found | A commented example |

`--db-url` needs the `pg` driver (`PG_DRIVER_MISSING`) and fails with `DB_CONNECTION_FAILED` after 10 s when the host does not answer. With `--no-introspect`, `init` never connects.

::: warning Prefer `--db-url` over the REST import
REST cannot read RLS. The imported tables then have no policies, so the first `push` turns RLS on for all of them. Existing database policies stay, but a table whose RLS was off becomes deny-all until you add policies or `enableRLS: false`.
:::

## What is imported

From the `public` schema, using a direct connection:

| Imported | Notes |
| --- | --- |
| Base tables and columns, nullability | System tables such as `spatial_ref_sys` are skipped |
| Column types | Mapped to AccessNexus types; anything unknown becomes `text` |
| Primary key | One column (see review list) |
| Foreign keys between `public` tables | As `references` |
| Unique constraints | As `unique: true` per column |
| RLS on or off | Off becomes an explicit `enableRLS: false` |
| Policies (`pg_policies`) | Translated fail-closed, see below |
| Functions (`pg_proc`) | Not trigger functions, not owned by an extension |

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

- Scalar arguments and return type: a full `rpc({ args, returns, language, security, body })`. `push` re-creates it with a pinned `search_path`; a definer function loses `EXECUTE` for `anon` unless you add `allowAnon: true`.
- `SETOF`, `TABLE(...)` or composite types: a signature-only `rpc()` marker. The function stays as it is in the database.
- Overloads: only the first is kept; the others become a comment.

## What to review before the first `generate`

Fix these **before** you run `generate` for the first time. The first migration uses `CREATE TABLE IF NOT EXISTS`, so declarations in it do not touch existing tables. After that, the same edits turn into `ALTER` migrations.

- **References to `auth.users`** (and any other non-`public` table) are not imported. Add them: `references: { user_id: 'auth.users.id' }`. The seed and the SDK `include` rely on them.
- **Composite primary keys** come out as a single column, and **composite unique constraints** come out as `unique: true` on each column. Fix the key, and express the composite with `indexes: [{ columns: ['org_id', 'user_id'], unique: true }]`.
- **Types**: enums, arrays and unknown types become `text`; `numeric` becomes `float`. Use `"enum('a','b')"`, `'text[]'`, `'decimal'`.
- **Not imported**: defaults, `CHECK` constraints, non-unique indexes, `ON DELETE` actions, triggers, views. They stay in the database; add them to the schema if you want them tracked.
- **Policies in `policy.custom()`**: replace with semantic builders where possible, and wrap auth calls (`validate` warns `UNWRAPPED_AUTH_CALL`).
- **`TODO` comments** for anon-only policies, and every `enableRLS: false`.

Then run `npx accessnexus validate` until it is clean.

## The safe first push

1. `npx accessnexus generate`, then read what it wrote:
   - `__init.sql`: `CREATE TABLE IF NOT EXISTS` (no-op for existing tables), `CREATE INDEX IF NOT EXISTS` on foreign-key and policy columns (new indexes), enum types if missing.
   - `policies/*.sql`: `ENABLE` + `FORCE ROW LEVEL SECURITY` and policies named `<prefix>_<table>_<op>`.
   - `rpcs.sql`: `CREATE OR REPLACE` of the imported functions.
2. `npx accessnexus push --dry-run`: the destructive list must be empty.
3. `npx accessnexus push` on staging, test the app, then on production.

After this push, both the original policies and the generated ones exist. `push` never drops policies it did not create, and Postgres ORs permissive policies, so the effective access is the union. Since the import never grants more, that union equals what you had.

::: danger Drop the originals only after review, and with consent
Until the original policies are gone, the schema is not the source of truth: an old permissive policy keeps granting access whatever the schema says. Once the app works with the generated policies, list the originals and drop them deliberately:

```sql
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'public' AND policyname NOT LIKE 'accessnexus\_%';

DROP POLICY "own notes" ON notes;
```

If an agent is driving, it must ask before dropping anything.
:::

## Related

- [CLI](/guide/cli): `init` flags
- [Security model](/guide/security)
- [Troubleshooting](/guide/troubleshooting)
- [Limits & roadmap](/guide/limits)
