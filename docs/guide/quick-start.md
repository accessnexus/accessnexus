# Quick start

This page takes you from an empty folder to an owner-only `notes` table running on Supabase, with RLS and a typed client. Requires Node.js 20 or later.

## Install

::: code-group

```bash [npm]
npm install -D accessnexus
npm install @supabase/supabase-js
npm install -D pg
```

```bash [pnpm]
pnpm add -D accessnexus
pnpm add @supabase/supabase-js
pnpm add -D pg
```

```bash [yarn]
yarn add -D accessnexus
yarn add @supabase/supabase-js
yarn add -D pg
```

:::

| Package | Why |
| --- | --- |
| `accessnexus` | CLI and schema builders |
| `@supabase/supabase-js` | Used by the generated SDK (optional peer dependency) |
| `pg` | Only needed by `push`, `seed` and `init --db-url` (optional peer dependency) |

The schema, config and seed files are bundled with esbuild, which ships with `accessnexus`. You do not need `tsx` or `ts-node`.

## Initialize

```bash
npx accessnexus init --yes
```

`--yes` accepts the defaults and never prompts, which is what you want in CI or from a coding agent. Without a TTY, `init` refuses to run without it (`INIT_NOT_INTERACTIVE`). In a folder with no `package.json`, it creates a minimal one first.

In a plain Node project this prints:

```
⬡ AccessNexus init

  ✓ Created a minimal package.json (no project found)
  → Detecting project...
  ✓ Framework: Node.js / other (no frontend framework detected)
  ✗ @supabase/supabase-js not found
  → Skipping — install later with `npm install @supabase/supabase-js`

  → No database URL or Supabase service key found — writing a template schema (pass --db-url <url> to import an existing database)


  ✓ accessnexus.schema.ts created
  → SDK generation skipped (no tables defined yet)
  → Edit accessnexus.schema.ts then run: npx accessnexus generate

  Framework files:
  ✓ lib/accessnexus/index.ts

  ✓ accessnexus.config.ts created
  ✓ Added "accessnexus" script to package.json
  ✓ AGENTS.md created (AccessNexus block for coding agents)

✓ AccessNexus initialized!
```

### Files created

| File | Owner | Purpose |
| --- | --- | --- |
| `accessnexus.schema.ts` | You | The single source of truth for tables and access rules |
| `accessnexus.config.ts` | You | Output folders, policy prefix, database URL env var |
| `lib/accessnexus/index.ts` | You | Client wrapper; `generate` never touches it. On Next.js it is `server.ts` + `browser.ts` |
| `AGENTS.md` | Shared | A marked AccessNexus block for coding agents (skip with `--no-agents`) |
| `package.json` | You | Gains an `accessnexus` script (`accessnexus generate`) |

`init` detects Next.js, Vite and CRA and writes matching client wrappers, and reuses an existing Supabase client when it finds one. To import an existing database instead of starting from the template, see [Adopting an existing project](/guide/existing-project).

## Define a table

Replace the template with an owner-only table: each signed-in user sees and edits only their own notes.

```ts [accessnexus.schema.ts]
import { defineSchema, policy, table, trigger } from 'accessnexus';

export default defineSchema({
  notes: table({
    columns: {
      id: 'uuid',
      user_id: 'uuid',
      body: 'text',
      created_at: { type: 'timestamptz', default: 'now()' },
      updated_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { user_id: 'auth.users.id' },
    indexes: [{ columns: ['user_id'] }],
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isOwner('user_id'),
      insert: policy.isOwner('user_id'),
      update: policy.isOwner('user_id'),
      delete: policy.isOwner('user_id'),
    },
  }),
});
```

- `'timestamptz?'` is nullable; every other column is `NOT NULL`.
- A `uuid` primary key defaults to `gen_random_uuid()`.
- `policy.isOwner('user_id')` compiles to `(SELECT auth.uid()) = user_id`.

::: warning Column names in policies are not type-checked
TypeScript accepts `policy.isOwner('usr_id')`. `validate` is what catches it (`UNKNOWN_COLUMN`), so run it after every schema edit.
:::

## Validate

```bash
npx accessnexus validate
```

```
⬡ AccessNexus validating...

  ✓ Config loaded: accessnexus.config.ts
  ✓ Schema is valid — 1 tables (manual mode)

  notes (5 columns, RLS: select/insert/update/delete)
```

Errors stop here with a path and a fix hint for each problem. See [Troubleshooting](/guide/troubleshooting).

## Preview with diff

Run `diff` **before** `generate`: it compares the schema with the files on disk, so right after `generate` it is empty.

```bash
npx accessnexus diff
```

```
⬡ AccessNexus diff...

  ✓ Config loaded: accessnexus.config.ts
  A added:    6
  M modified: 0
  D removed:  0

  A generated/migrations/.snapshot.json
  ...
```

Each entry is followed by its unified diff. Use `diff --check` in CI: it exits `1` when generated files are out of date.

## Generate

```bash
npx accessnexus generate
```

```
  Migrations:
  ✓ generated/migrations/20261029213510__init.sql
  ✓ generated/migrations/.snapshot.json

  SQL Policies:
  ✓ generated/policies/notes_rls.sql

  Triggers:
  ✓ generated/triggers/notes_triggers.sql

  Typed SDK:
  ✓ lib/accessnexus/types.ts
  ✓ lib/accessnexus/client.ts

✓ Done! 6 created, 0 updated, 0 unchanged
```

The policy file is plain SQL you can review:

```sql [generated/policies/notes_rls.sql]
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "accessnexus_notes_update" ON notes;
CREATE POLICY "accessnexus_notes_update"
  ON notes FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
  );
```

::: danger Do not edit generated files
Everything under `generated/` and the SDK's `client.ts` / `types.ts` is derived. Change the schema and regenerate. `push` refuses an applied migration that was edited (`MIGRATION_DRIFT`).
:::

## Push

`push` is the only command that touches the database. Point it at your Supabase project with the **Session pooler** connection string (Dashboard → Connect). It runs as the `postgres` user, which bypasses RLS as the generated helpers require.

```bash [.env]
SUPABASE_DB_URL=postgres://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres
```

`.env` and `.env.local` are loaded automatically. You can also pass `--url` or set `ACCESSNEXUS_DB_URL` / `DATABASE_URL`.

First, a dry run. It lists what would be applied and needs no database:

```bash
npx accessnexus push --dry-run
```

```
⬡ AccessNexus push...

  ✓ Config loaded: accessnexus.config.ts
  Adapter: supabase
  Files:   3
  - Migrations: 1
      generated/migrations/20261029213510__init.sql
  - Policies: 1
      generated/policies/notes_rls.sql
  - Triggers: 1
      generated/triggers/notes_triggers.sql

  ✓ Dry run — execution skipped
```

Then apply:

```bash
npx accessnexus push
```

```
  Migrations:
  ✓ generated/migrations/20261029213510__init.sql

  Policies:
  ✓ generated/policies/notes_rls.sql

  Triggers:
  ✓ generated/triggers/notes_triggers.sql

✓ Push complete! Applied 3 SQL file(s), skipped 0.
```

Running it again skips every file (`already applied`). `push` also refuses to run when the generated SQL is older than the schema (`GENERATED_OUT_OF_DATE`) or when a pending migration drops data (`DESTRUCTIVE_MIGRATION`) unless you pass `--allow-destructive`.

## Use the SDK

The wrapper `init` wrote creates a Supabase client and passes it to the generated `createAccessNexusClient`. Adjust the environment variable names in it to match your app.

```ts [app.ts]
import { accessnexus } from './lib/accessnexus/index.js';

export async function addNote(body: string) {
  const { data: auth } = await accessnexus.auth.getUser();
  if (!auth.user) throw new Error('Sign in first');

  // id, created_at and updated_at are optional in NotesCreate
  const { data: note, error } = await accessnexus.notes.create({ user_id: auth.user.id, body });
  if (error) throw error;

  const { data: mine } = await accessnexus.notes.findMany();
  return { note, mine };
}
```

Each table gets `findMany(filter?)`, `findById(id)`, `create(row)`, `update(id, patch)` and `delete(id)`. Results are `{ data, error }`, like `supabase-js`. RLS still applies: the SDK runs as the signed-in user, so `findMany()` returns only that user's notes.

::: tip The typical loop
Edit the schema, then `validate` → `diff` → `generate` → `push --dry-run` → `push`. A coding agent follows the same loop with `--json`.
:::

## Next steps

- [Schema](/guide/schema) - column types, defaults, references, indexes and soft delete
- [Policies](/guide/policies) - every `policy.*` builder and the SQL it compiles to
- [Permissions](/guide/permissions) - roles and multi-tenant access with `definePermissions`
- [CLI](/guide/cli) - every command and flag
