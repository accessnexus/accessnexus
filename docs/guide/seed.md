# Seed

A seed file puts known rows into a development database: a few users, an org, some projects, so the app has something to show and RLS has something to filter. AccessNexus turns it into upsert SQL and runs it in one transaction.

The seed never runs on its own. It runs only when you call `accessnexus seed` or `accessnexus push --seed`.

## Write the seed file

The default path is `./accessnexus.seed.ts` (change it with `seed` in `accessnexus.config.ts`, or `--seed <path>` on the `seed` command). Default-export `defineSeed(...)`.

::: code-group

```ts [Manual mode]
// accessnexus.seed.ts
import { defineSeed } from 'accessnexus';
import schema from './accessnexus.schema.js';

export default defineSeed(schema, {
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Admin' },
  ],
});
```

```ts [Database mode]
// accessnexus.seed.ts
import { defineSeed } from 'accessnexus';
import type { Database } from './database.types.js';

export default defineSeed<Database>({
  profiles: [
    { id: '00000000-0000-0000-0000-000000000001', name: 'Admin' },
  ],
});
```

:::

| Overload | Checked by TypeScript |
| --- | --- |
| `defineSeed(schema, data)` (manual mode) | Table names only. Rows are plain objects: a misspelled column surfaces as a Postgres error when the seed runs. Preview with `seed --dry-run`. |
| `defineSeed<Database>(data)` (Database mode) | Table names and each row, against the table's `Insert` type. |

Use fixed UUIDs for primary keys and for every id other rows point at. That is what makes the seed repeatable and lets rows reference each other.

## Run it

```bash
npx accessnexus seed --dry-run      # print the SQL, no database needed
npx accessnexus seed                # run it against the database
npx accessnexus push --seed         # push the schema, then seed
```

The database URL resolves like `push`: `--url`, then `adapterOptions.dbUrlEnv` (of the `--target`, if given), then `ACCESSNEXUS_DB_URL`, `SUPABASE_DB_URL`, `DATABASE_URL`. `.env` and `.env.local` are loaded. Seeding needs the `pg` driver (`npm install -D pg`).

Tables are inserted in foreign-key order, so a row can reference rows of another table in the same seed. Run the seed after `push`: the tables must exist.

## Seeded users in `auth.users`

Rows often point at users: `profiles.id`, `projects.owner_id`. For every value in a column whose reference is `auth.users.id`, the seed first creates that user in `auth.users`:

- with the email from the row's `email` column, if the row has one;
- with the email already confirmed;
- with a **random, unknowable password** (bcrypt of 24 random bytes);
- with `ON CONFLICT (id) DO NOTHING`, so an existing user is left untouched.

To sign in as seeded users locally, choose the password through the environment:

```bash
ACCESSNEXUS_SEED_PASSWORD='local-dev-only' npx accessnexus seed
```

The password applies only when a user is created. Re-running the seed with a different value does not change the password of users that already exist.

::: warning Declare the reference in the table's `references` map
In v0.1.0 the seed finds user columns through the table-level map, `references: { owner_id: 'auth.users.id' }`. A reference written in the column's object form (`owner_id: { type: 'uuid', references: 'auth.users.id' }`) creates the same foreign key, but the seed does not provision that user, and the insert fails with a foreign key error. Use the table-level map for columns you seed. In Database mode, add `references` to the table entry for the same reason.
:::

::: danger Never set a fixed seed password on a reachable database
`ACCESSNEXUS_SEED_PASSWORD` creates accounts anyone who knows the password can sign in to. Use it only on a local database (`supabase start`). Without it, seeded users have passwords nobody knows.
:::

## Hosted projects are refused by default

Seeds are for local and disposable databases. `seed` and `push --seed` refuse a hosted Supabase host (`*.supabase.co`, `*.supabase.com`) with `SEED_REMOTE_BLOCKED`:

```
✗ Refusing to seed a hosted Supabase database (postgresql://postgres.abc:***@aws-0-eu-central-1.pooler.supabase.com:5432/postgres) [SEED_REMOTE_BLOCKED]
```

Pass `--allow-remote-seed` only for a project you can throw away (a preview branch, a staging copy). With `push --seed`, the check runs before any SQL is applied, so a refused seed also means nothing was pushed.

## Re-running is safe

Each row becomes an upsert on the table's primary key:

```sql
INSERT INTO "projects" ("id", "org_id", "name") VALUES ('3000...', '1000...', 'Website Redesign')
  ON CONFLICT ("id") DO UPDATE SET "org_id" = EXCLUDED."org_id", "name" = EXCLUDED."name";
```

So a second run:

- creates rows that are missing;
- resets the columns you listed to the seed's values (other columns keep their current values);
- never deletes rows, including rows you removed from the seed file;
- fires `UPDATE` triggers on existing rows (`updated_at` moves, `trigger.auditLog` writes new entries).

A table without a `primaryKey` in the schema is upserted on `id`.

::: tip Triggers run during the seed
The seed is plain SQL run as the push role, so every trigger fires. If a trigger already creates a row (for example an AFTER INSERT trigger that adds the creator of a team as its first owner), do not seed that row too: the second insert hits the unique index and the whole seed fails.
:::

## When it fails

The whole seed runs in a single transaction. If Postgres rejects any statement, nothing from the seed is kept, and the CLI exits with code 1:

| Code | Meaning | Fix |
| --- | --- | --- |
| `SEED_NOT_FOUND` | No seed file at the path | Create `accessnexus.seed.ts`, pass `--seed <path>`, or set `seed` in the config |
| `SEED_EMPTY` | The file exports no rows | Default-export `defineSeed(schema, { table: [rows] })` |
| `SEED_LOAD_FAILED` | The file threw while loading, or imports a missing package | Fix the named file or import |
| `SEED_FAILED` | Postgres rejected a statement (message included); the seed was rolled back | Check that `push` ran, that columns exist, and that no unique key collides |
| `SEED_REMOTE_BLOCKED` | Hosted Supabase host | Use a local database, or `--allow-remote-seed` for a disposable one |
| `DB_URL_MISSING`, `PG_DRIVER_MISSING`, `DB_CONNECTION_FAILED` | Same as for `push` | See [Troubleshooting](/guide/troubleshooting) |

With `push --seed`, the push and the seed are separate steps. When the seed fails, the SQL files are already applied: the JSON result keeps `applied[]` and reports `seed.status: "failed"`. Fix the seed and run `accessnexus seed`; there is no need to push again.

## Related

- [CLI](/guide/cli): `seed` and `push --seed` flags
- [`defineSeed` / `defineConfig` reference](/api/seed-config)
- [Troubleshooting](/guide/troubleshooting)
- [Schema](/guide/schema): `references` and primary keys
