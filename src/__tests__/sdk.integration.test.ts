// The generated SDK end to end: a real PostgREST over a real Supabase Postgres, called as
// signed-in users. Skipped unless both are set:
//
//   ACCESSNEXUS_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres
//   ACCESSNEXUS_TEST_REST_URL=http://127.0.0.1:55440
//
// PostgREST (same database as push.integration.test.ts; JWT secret below):
//
//   docker exec accessnexus-test-pg psql -U supabase_admin -d postgres -c \
//     "ALTER ROLE authenticator WITH LOGIN PASSWORD 'postgres'"
//   docker run -d --rm --name accessnexus-test-rest --network host \
//     -e PGRST_DB_URI=postgres://authenticator:postgres@127.0.0.1:55439/postgres \
//     -e PGRST_DB_ANON_ROLE=anon -e PGRST_DB_SCHEMAS=public -e PGRST_SERVER_PORT=55440 \
//     -e PGRST_JWT_SECRET=accessnexus-test-jwt-secret-at-least-32-chars postgrest/postgrest:v12.2.3
//
// The tests DROP every table in the public schema of that database.

import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const REST_URL = process.env.ACCESSNEXUS_TEST_REST_URL;
const JWT_SECRET = process.env.ACCESSNEXUS_TEST_JWT_SECRET ?? 'accessnexus-test-jwt-secret-at-least-32-chars';
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const NOTE = 'aaaaaaaa-0000-0000-0000-000000000001';
const POST = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC = 'cccccccc-0000-0000-0000-000000000003';

function jwt(sub: string): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`;
}

let pg: any;
let admin: any;
let cwd: string;
let previousCwd: string;
let sdk: any;

/** The generated client over PostgREST, signed in as `user`. */
function clientAs(user: string): any {
  const rest = new PostgrestClient(REST_URL!, { headers: { Authorization: `Bearer ${jwt(user)}` } });
  return sdk.createAccessNexusClient({ auth: {}, from: (t: string) => rest.from(t), rpc: (n: string, a?: object) => rest.rpc(n, a) });
}

async function cli(...argv: string[]): Promise<number> {
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const needsDb = argv[0] === 'push';
  const code = await runCli([...argv, '--json', ...(needsDb ? ['--url', DB_URL!] : [])]);
  vi.restoreAllMocks();
  return code;
}

describe.skipIf(!DB_URL || !REST_URL)('generated SDK over a real PostgREST', () => {
  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock(727274)');
    await admin.query(`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
        END LOOP;
      END $$;`);

    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-sdk-it-'));
    process.chdir(cwd);
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), `
import { defineSchema, table, policy, rpc } from '${SRC_INDEX}';
const own = policy.isOwner('owner_id');
export default defineSchema({
  // Hidden from other users entirely.
  sdk_notes: table({ columns: { id: 'uuid', owner_id: 'uuid', body: 'text' }, primaryKey: 'id',
    policies: { select: own, insert: own, update: own, delete: own } }),
  // Everyone reads; only the owner writes.
  sdk_posts: table({ columns: { id: 'uuid', owner_id: 'uuid', title: 'text' }, primaryKey: 'id',
    policies: { select: policy.isAuthenticated(), insert: own, update: own, delete: own } }),
  // Soft delete: DELETE sets deleted_at.
  sdk_docs: table({ columns: { id: 'uuid', owner_id: 'uuid', slug: 'text', deleted_at: 'timestamptz?' }, primaryKey: 'id',
    softDelete: 'deleted_at', policies: { select: policy.isAuthenticated(), insert: own, update: own, delete: own } }),
}, {
  rpcs: {
    my_notes: rpc({ returns: { setof: 'sdk_notes' }, language: 'sql', volatility: 'stable',
      body: 'SELECT * FROM sdk_notes WHERE owner_id = (SELECT auth.uid());' }),
  },
});`);
    expect(await cli('generate', '--output', 'out')).toBe(0);
    expect(await cli('push', '--output', 'out')).toBe(0);
    await admin.query(`NOTIFY pgrst, 'reload schema'`);
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${REST_URL}/sdk_notes`, { headers: { Authorization: `Bearer ${jwt(ALICE)}` } });
      if (res.ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const source = readFileSync(join(cwd, 'out', 'sdk', 'client.ts'), 'utf-8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
    writeFileSync(join(cwd, 'client.mjs'), js);
    sdk = await import(pathToFileURL(join(cwd, 'client.mjs')).href);
  }, 120_000);

  afterAll(async () => {
    if (previousCwd) process.chdir(previousCwd);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    await admin?.end();
  });

  /** NOT_FOUND_OR_DENIED, with the whole response in the failure message. */
  const expectDenied = (res: any) =>
    expect(res?.error?.code, `expected NOT_FOUND_OR_DENIED, got ${JSON.stringify(res)}`).toBe('ACCESSNEXUS_NOT_FOUND_OR_DENIED');

  const seed = async () => {
    await admin.query('TRUNCATE sdk_notes, sdk_posts, sdk_docs');
    await admin.query(`INSERT INTO sdk_notes (id, owner_id, body) VALUES ('${NOTE}', '${ALICE}', 'n')`);
    await admin.query(`INSERT INTO sdk_posts (id, owner_id, title) VALUES ('${POST}', '${ALICE}', 'p')`);
    await admin.query(`INSERT INTO sdk_docs (id, owner_id, slug) VALUES ('${DOC}', '${ALICE}', 'd')`);
  };
  const exists = async (table: string, id: string, live = false) =>
    (await admin.query(`SELECT 1 FROM ${table} WHERE id = $1${live ? ' AND deleted_at IS NULL' : ''}`, [id])).rowCount === 1;

  it('delete(id): denied or missing is NOT_FOUND_OR_DENIED, allowed is a clean success', async () => {
    await seed();
    const bob = clientAs(BOB);
    for (const [table, id] of [['sdk_notes', NOTE], ['sdk_posts', POST]] as const) {
      const denied = await bob[table].delete(id);
      expect(denied.error?.code).toBe('ACCESSNEXUS_NOT_FOUND_OR_DENIED');
      expect(sdk.isNotFoundOrDenied(denied.error)).toBe(true);
      expect(sdk.isAccessDenied(denied.error)).toBe(true);
      expect(denied.error.details).toEqual({ table, method: 'delete', id });
      expect(await exists(table, id)).toBe(true);
    }
    const missing = await clientAs(ALICE).sdk_notes.delete('dddddddd-0000-0000-0000-000000000009');
    expect(missing.error?.code).toBe('ACCESSNEXUS_NOT_FOUND_OR_DENIED');

    const ok = await clientAs(ALICE).sdk_notes.delete(NOTE);
    expect(ok).toEqual({ data: null, error: null });
    expect(await exists('sdk_notes', NOTE)).toBe(false);
  });

  it('delete(id) on a soft-delete table: denied is reported, allowed soft-deletes', async () => {
    await seed();
    const denied = await clientAs(BOB).sdk_docs.delete(DOC);
    expect(denied.error?.code).toBe('ACCESSNEXUS_NOT_FOUND_OR_DENIED');
    expect(await exists('sdk_docs', DOC, true)).toBe(true);
    const ok = await clientAs(ALICE).sdk_docs.delete(DOC);
    expect(ok.error).toBeNull();
    expect(await exists('sdk_docs', DOC, true)).toBe(false);
    expect(await exists('sdk_docs', DOC)).toBe(true); // soft-deleted, still in the table
    const again = await clientAs(ALICE).sdk_docs.delete(DOC);
    expect(again.error?.code).toBe('ACCESSNEXUS_NOT_FOUND_OR_DENIED');
  });

  it('update / updateOne / deleteOne: no changed row is NOT_FOUND_OR_DENIED', async () => {
    await seed();
    const bob = clientAs(BOB);
    expectDenied(await bob.sdk_notes.update(NOTE, { body: 'x' }));
    expectDenied(await bob.sdk_posts.update(POST, { title: 'x' }));
    expectDenied(await bob.sdk_posts.updateOne({ id: POST }, { title: 'x' }));
    expectDenied(await bob.sdk_posts.deleteOne({ id: POST }));
    expectDenied(await bob.sdk_docs.deleteOne({ slug: 'd' }));
    expect((await admin.query('SELECT title FROM sdk_posts')).rows[0].title).toBe('p');

    const alice = clientAs(ALICE);
    const updated = await alice.sdk_notes.update(NOTE, { body: 'y' });
    expect(updated.error).toBeNull();
    expect(updated.data).toMatchObject({ id: NOTE, body: 'y' });
    expect((await alice.sdk_posts.updateOne({ id: POST }, { title: 'z' }, { columns: ['id', 'title'] })).data).toEqual({ id: POST, title: 'z' });
    const soft = await alice.sdk_docs.deleteOne({ slug: 'd' }, { columns: ['id', 'slug'] });
    expect(soft).toEqual({ data: { id: DOC, slug: 'd' }, error: null });
    expect(await exists('sdk_docs', DOC, true)).toBe(false);
    // Many-row writes keep returning [] when nothing matches.
    expect(await bob.sdk_posts.updateMany({ owner_id: ALICE }, { title: 'x' })).toMatchObject({ data: [], error: null });
  });

  it('an INSERT rejected by RLS is isAccessDenied (42501)', async () => {
    await seed();
    const res = await clientAs(BOB).sdk_notes.create({ id: 'eeeeeeee-0000-0000-0000-000000000005', owner_id: ALICE, body: 'x' });
    expect(res.error?.code).toBe('42501');
    expect(sdk.isAccessDenied(res.error)).toBe(true);
    expect(sdk.isNotFoundOrDenied(res.error)).toBe(false);
  });

  it('a SETOF RPC returns rows', async () => {
    await seed();
    const res = await clientAs(ALICE).rpc.my_notes();
    expect(res.error).toBeNull();
    expect(res.data.map((r: any) => r.id)).toEqual([NOTE]);
  });
});
