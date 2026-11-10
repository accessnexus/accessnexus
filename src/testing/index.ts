// ============================================
// accessnexus/testing — RLS test kit
// Run SQL as a Supabase API user against a disposable Postgres, and assert
// how RLS answers (an error, or zero rows).
// ============================================

/** A `pg` Pool (or anything with `connect()` returning a client). */
export interface TestPool {
  connect(): Promise<TestClient>;
}

/** A `pg` client (PoolClient). */
export interface TestClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}

/** The signed-in user a test acts as. */
export interface TestUser {
  id: string;
  email?: string;
  /** Global app role (`app_metadata.role`, what `policy.hasRole` reads). */
  appRole?: string;
  /** Extra JWT claims merged into `request.jwt.claims`. */
  claims?: Record<string, unknown>;
}

/**
 * Run `fn` as `user` (or anonymously with `null`) the way PostgREST does —
 * `SET LOCAL ROLE authenticated|anon` plus the JWT claims — inside a
 * transaction that is ALWAYS rolled back, so tests never see each other's writes.
 */
export async function asUser<T>(pool: TestPool, user: TestUser | null, fn: (db: TestClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claims = user
      ? {
          sub: user.id,
          role: 'authenticated',
          aud: 'authenticated',
          ...(user.email ? { email: user.email } : {}),
          ...(user.appRole ? { app_metadata: { role: user.appRole } } : {}),
          ...user.claims,
        }
      : { role: 'anon' };
    await client.query(`SET LOCAL ROLE ${user ? 'authenticated' : 'anon'}`);
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [JSON.stringify(claims), user?.id ?? ''],
    );
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** `asUser(pool, null, fn)`: an anonymous visitor (role `anon`). */
export function asAnon<T>(pool: TestPool, fn: (db: TestClient) => Promise<T>): Promise<T> {
  return asUser(pool, null, fn);
}

/**
 * The SQLSTATE `sql` fails with, or `'ok'`. Runs in a savepoint, so the
 * surrounding transaction (and the next statements of the test) survive.
 */
export async function sqlState(db: TestClient, sql: string, params: readonly unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT accessnexus_test');
  try {
    await db.query(sql, [...params]);
    await db.query('RELEASE SAVEPOINT accessnexus_test');
    return 'ok';
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT accessnexus_test');
    return (error as { code?: string }).code ?? 'unknown';
  }
}

/** Rows a statement affected (an UPDATE/DELETE on rows RLS hides affects 0, silently). */
export async function affectedRows(db: TestClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  return (await db.query(sql, [...params])).rowCount ?? 0;
}

/** How RLS refused a statement. */
export type Denial = { denied: true; by: 'error'; sqlState: string } | { denied: true; by: 'no_rows' };

/**
 * Assert that `sql` was refused, whichever way RLS refuses it:
 * - INSERT, or an UPDATE whose new row fails WITH CHECK → an error (42501);
 * - UPDATE / DELETE on rows the USING clause hides → no error, 0 rows.
 * Throws when the statement succeeded and changed rows. Savepoint-wrapped.
 */
export async function expectDenied(db: TestClient, sql: string, params: readonly unknown[] = []): Promise<Denial> {
  await db.query('SAVEPOINT accessnexus_test');
  let rows: number;
  try {
    rows = (await db.query(sql, [...params])).rowCount ?? 0;
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT accessnexus_test');
    return { denied: true, by: 'error', sqlState: (error as { code?: string }).code ?? 'unknown' };
  }
  await db.query('ROLLBACK TO SAVEPOINT accessnexus_test');
  if (rows === 0) return { denied: true, by: 'no_rows' };
  throw new Error(`expected the statement to be denied, but it changed ${rows} row(s): ${sql}`);
}

/**
 * SQL that makes the bare `supabase/postgres` image behave like a Supabase
 * project for RLS tests (run it as `supabase_admin`): `auth.uid()` / `auth.jwt()`
 * reading `request.jwt.claims` as GoTrue's versions do, `auth.users.email_confirmed_at`,
 * a login for `authenticator` (PostgREST), and stand-ins for `realtime.messages` /
 * `realtime.topic()` (created by the Realtime service on a real project).
 */
export const TEST_DB_STANDINS_SQL = `
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
ALTER ROLE authenticator WITH LOGIN PASSWORD 'postgres';
CREATE TABLE IF NOT EXISTS realtime.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(), topic text NOT NULL, extension text NOT NULL,
  payload jsonb, event text, private boolean DEFAULT false,
  inserted_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('realtime.topic', true), '')::text $$;
GRANT USAGE ON SCHEMA realtime TO postgres, anon, authenticated;
GRANT SELECT, INSERT ON realtime.messages TO anon, authenticated;
GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated;
ALTER TABLE realtime.messages OWNER TO postgres;
`;
