# Testing RLS

`validate` proves the schema is well formed; it does not prove that a policy blocks what it should. For that, run SQL as real API users against a real Postgres and assert how RLS answers. AccessNexus ships the two pieces:

- `accessnexus test-db up | down`: a disposable local Supabase Postgres in Docker, prepared for RLS tests.
- `accessnexus/testing`: a small kit (`asUser`, `asAnon`, `sqlState`, `affectedRows`, `expectDenied`) that acts as an API user inside a transaction that is always rolled back.

::: warning
Never point tests at a hosted project. The kit is for the throwaway database `test-db` creates (or one you made the same way).
:::

## Start the test database

```bash
npx accessnexus test-db up --push   # start the container and push your schema
npx accessnexus test-db down        # remove it
```

`up` starts `ghcr.io/supabase/postgres` on port `55433` (`--port`, `--name`, `--image` change it) and prints the URL, `postgres://postgres:postgres@127.0.0.1:55433/postgres`. It prepares the database the way a Supabase project behaves for RLS: `auth.uid()` and `auth.jwt()` read the request's JWT claims (as GoTrue's do), `auth.users` has `email_confirmed_at`, the `authenticator` role can log in and `realtime.messages` exists. `--push` also runs [`push`](/api/cli#push) against it, so the tables, policies, triggers and RPCs are the ones your schema generates. It waits until connections stay up (the image restarts Postgres after its init). Docker must be installed (`DOCKER_NOT_FOUND`), the port must be free (`TEST_DB_PORT_IN_USE`: pick another `--port`) and so must the container name (`TEST_DB_START_FAILED`).

## Write the tests

Install the `pg` driver (`npm install -D pg`) and your test runner. Create fixtures as the `postgres` user, which bypasses RLS (including the `auth.users` rows your foreign keys point at), and run every check as an API user:

```ts
import pg from 'pg';
import { asAnon, asUser, affectedRows, expectDenied, sqlState } from 'accessnexus/testing';

const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55433/postgres' });
const ALICE = { id: '00000000-0000-4000-8000-000000000001', email: 'alice@test.dev' };

export async function checks() {
  // Fixtures as `postgres` (bypasses RLS): pool.query('INSERT ...').
  await asUser(pool, ALICE, async (db) => {
    // Every check runs as the API user, in a transaction that is always rolled back.
    const insert = await sqlState(db, 'INSERT INTO notes (owner_id, body) VALUES ($1, $2)', [ALICE.id, 'x']); // 'ok' | '42501' | ...
    const hidden = await expectDenied(db, 'DELETE FROM notes WHERE owner_id <> $1', [ALICE.id]); // { denied: true, by: 'no_rows' }
    const changed = await affectedRows(db, 'UPDATE notes SET body = $1 WHERE owner_id = $2', ['y', ALICE.id]);
    return { insert, hidden, changed };
  });
  await asAnon(pool, async (db) => (await db.query('SELECT count(*) FROM notes')).rows);
}
```

With a test runner the checks become assertions:

```ts
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { asUser, expectDenied, sqlState } from 'accessnexus/testing';

const pool = new pg.Pool({ connectionString: process.env.ACCESSNEXUS_TEST_DB_URL });
const ALICE = { id: '00000000-0000-4000-8000-000000000001', email: 'alice@test.dev' };
const BOB = { id: '00000000-0000-4000-8000-000000000002', email: 'bob@test.dev' };

describe('notes', () => {
  it('lets the owner write their own rows', async () => {
    const state = await asUser(pool, ALICE, (db) => sqlState(db, 'INSERT INTO notes (owner_id, body) VALUES ($1, $2)', [ALICE.id, 'x']));
    expect(state).toBe('ok');
  });

  it('refuses a row attributed to someone else', async () => {
    const result = await asUser(pool, BOB, (db) => expectDenied(db, 'INSERT INTO notes (owner_id, body) VALUES ($1, $2)', [ALICE.id, 'x']));
    expect(result).toEqual({ denied: true, by: 'error', sqlState: '42501' });
  });
});
```

## The kit

All of these come from `accessnexus/testing`. `db` is a `pg` client (or anything with `query`) passed to your callback.

| Export | Signature | What it does |
| --- | --- | --- |
| `asUser` | `(pool, user, fn) => Promise<T>` | Runs `fn(db)` as `user`: `SET LOCAL ROLE authenticated` and the JWT claims `request.jwt.claims` (`sub`, `email`, `app_metadata.role` from `appRole`, plus any `claims`), the way PostgREST does. Everything runs in a transaction that is **always rolled back**, so tests never see each other's writes. |
| `asAnon` | `(pool, fn) => Promise<T>` | The same as an anonymous visitor (`ROLE anon`); it is `asUser(pool, null, fn)`. |
| `sqlState` | `(db, sql, params?) => Promise<string>` | The SQLSTATE the statement fails with, or `'ok'`. It uses a savepoint, so a denied statement does not abort the test. |
| `affectedRows` | `(db, sql, params?) => Promise<number>` | Rows the statement affected. An UPDATE or DELETE on rows RLS hides affects `0`, silently. |
| `expectDenied` | `(db, sql, params?) => Promise<Denial>` | Asserts the statement was refused, in either form RLS refuses: an error (`{ denied: true, by: 'error', sqlState }`) or zero rows (`{ denied: true, by: 'no_rows' }`). Throws when the statement succeeded and changed rows. Savepoint-wrapped, and it rolls the statement back either way. |
| `TEST_DB_STANDINS_SQL` | `string` | The preparation SQL that `test-db up` runs, for your own containers (see below). |

`TestUser` is `{ id: string; email?: string; appRole?: string; claims?: Record<string, unknown> }`. `appRole` becomes `app_metadata.role`, which is what [`policy.hasRole`](/api/policy#hasrole) and role arrays read; `claims` are merged into the JWT.

Use `expectDenied` for anything that must be refused: it handles both ways RLS says no, so the test does not depend on which clause refuses.

## How a denial shows

RLS refuses a statement in one of two ways, depending on the clause, and a few guards raise their own errors. Knowing which is which decides how you assert it:

| Statement | RLS clause that refuses | What the caller gets |
| --- | --- | --- |
| `INSERT` | `WITH CHECK` | error `42501` (`new row violates row-level security policy`) |
| `UPDATE`, row hidden by `USING` | `USING` | no error, 0 rows |
| `UPDATE`, new row fails `WITH CHECK` | `WITH CHECK` | error `42501` |
| `DELETE`, row hidden or not deletable | `USING` | no error, 0 rows |
| `SELECT` | `USING` | the row is simply not returned |
| [`trigger.lockColumns`](/api/trigger#lockcolumns) | trigger | error `42501`, HINT `accessnexus:locked_column:<table>.<column>` |
| [`sameTenant`](/api/trigger#sametenant) / [`memberOfTenant`](/api/trigger#memberoftenant) | trigger | error `23503` |
| [`keepAtLeastOne`](/api/trigger#keepatleastone) | trigger | error `23514` |

In the app, the generated SDK turns the 0-row cases of `update(id)`, `delete(id)`, `updateOne` and `deleteOne` into the error `ACCESSNEXUS_NOT_FOUND_OR_DENIED`; see [SDK errors](/api/sdk#errors).

## Your own container

`test-db` is the shortest path. If you run Postgres another way (a CI service container, your own compose file), start a `supabase/postgres` image and run `TEST_DB_STANDINS_SQL` as `supabase_admin`, then `push` against it:

```ts
import { TEST_DB_STANDINS_SQL } from 'accessnexus/testing';

// psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < the SQL below
export const preparationSql: string = TEST_DB_STANDINS_SQL;
```

It defines `auth.uid()` / `auth.jwt()` that read `request.jwt.claims`, adds `auth.users.email_confirmed_at`, gives `authenticator` a login, and creates stand-ins for `realtime.messages` and `realtime.topic()` (a real project has them from the Realtime service).

## A full suite

`examples/saas-teams/` in the repository is a complete multi-tenant schema (teams, roles, projects, tasks, invitations) built from [`definePermissions`](/guide/permissions), the tenant triggers and [`tenantInvitations`](/api/tenancy#tenantinvitations). Its RLS suite, `src/__tests__/saas-teams.integration.test.ts`, pushes that schema to a real Postgres and checks, as real API users, who can read, write, move, invite and delete what. It is the template to copy: a table of users with different roles, fixtures created as `postgres`, and one `it` per rule that must hold, written with the kit above.
