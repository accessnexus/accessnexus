// Integration: TABLE/SETOF-returning functions imported by `init --db-url`,
// regenerated and pushed (including a result-type change), the SDK's typed
// call, filtered writes (updateOne) under RLS, and `policies.all`.
//
// Skipped unless ACCESSNEXUS_TEST_DB_URL points at a disposable database (see
// the header of push.integration.test.ts for the docker + auth.jwt() setup).
// The test DROPS every table, function and enum type in the public schema.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');
const ALICE = '61111111-1111-1111-1111-111111111111';
const BOB = '62222222-2222-2222-2222-222222222222';

const FIXTURE = `
CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL,
  slug text NOT NULL UNIQUE,
  date_time timestamptz NOT NULL DEFAULT now(),
  services json NOT NULL DEFAULT '[]',
  price numeric NOT NULL DEFAULT 0,
  reviewed boolean NOT NULL DEFAULT false
);
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_select ON public.bookings FOR SELECT TO authenticated USING ((SELECT auth.uid()) = client_id);
CREATE POLICY own_update ON public.bookings FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = client_id) WITH CHECK ((SELECT auth.uid()) = client_id);

CREATE FUNCTION public.get_client_bookings(p_client_id uuid)
RETURNS TABLE(booking_id uuid, date_time timestamptz, services json, has_review boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT b.id, b.date_time, b.services, b.reviewed FROM public.bookings b
  WHERE b.client_id = p_client_id AND p_client_id = (SELECT auth.uid())
$$;
REVOKE EXECUTE ON FUNCTION public.get_client_bookings(uuid) FROM PUBLIC, anon;

CREATE FUNCTION public.bookings_after(p_from timestamptz)
RETURNS SETOF public.bookings LANGUAGE sql STABLE AS $$
  SELECT * FROM public.bookings WHERE date_time >= p_from
$$;
`;

let pg: any;
let admin: any;

async function resetDatabase(): Promise<void> {
  await admin.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig);
      END LOOP;
      FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
      END LOOP;
    END $$;
  `);
}

/** Run statements as an API user (`authenticated`, or `anon` for null). */
async function asUser(userId: string | null, sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${userId ? 'authenticated' : 'anon'}`);
    const claims = JSON.stringify({ sub: userId, role: userId ? 'authenticated' : 'anon' });
    await client.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [claims, userId ?? '']);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const needsDb = argv[0] === 'push' || argv[0] === 'seed';
  const code = await runCli([...argv, '--json', ...(needsDb ? ['--url', DB_URL!] : [])]);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout) };
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry === name) return full;
  }
  return null;
}

function typecheck(file: string): string[] {
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/**
 * A tiny PostgREST stand-in for the generated client: each query-builder chain
 * becomes ONE SQL statement run as the given user (counted in `statements`).
 */
function restStandIn(userId: string | null, statements: string[]) {
  const chain = (table: string) => {
    const st: { op?: string; data?: Record<string, unknown>; where: Array<[string, unknown]>; cols?: string; single?: boolean } = { where: [] };
    const b: any = {
      select(cols?: string) { if (!st.op) st.op = 'select'; st.cols = cols ?? '*'; return b; },
      update(data: Record<string, unknown>) { st.op = 'update'; st.data = data; return b; },
      delete() { st.op = 'delete'; return b; },
      insert(data: Record<string, unknown>) { st.op = 'insert'; st.data = data; return b; },
      match(filter: Record<string, unknown>) { for (const [k, v] of Object.entries(filter)) st.where.push([k, v]); return b; },
      eq(k: string, v: unknown) { st.where.push([k, v]); return b; },
      is(k: string, v: null) { st.where.push([k, v]); return b; },
      maybeSingle() { st.single = true; return b; },
      single() { st.single = true; return b; },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        const params: unknown[] = [];
        const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
        const where = st.where.length ? ` WHERE ${st.where.map(([k, v]) => (v === null ? `${k} IS NULL` : `${k} = ${p(v)}`)).join(' AND ')}` : '';
        const ret = st.cols ? ` RETURNING ${st.cols}` : '';
        let sql: string;
        if (st.op === 'update') sql = `UPDATE ${table} SET ${Object.keys(st.data!).map((k) => `${k} = ${p(st.data![k])}`).join(', ')}${where}${ret}`;
        else if (st.op === 'delete') sql = `DELETE FROM ${table}${where}${ret}`;
        else sql = `SELECT ${st.cols} FROM ${table}${where}`;
        statements.push(sql);
        asUser(userId, sql, params).then(({ rows }) => {
          if (st.single && rows.length > 1) return resolve({ data: null, error: { code: 'PGRST116' } });
          resolve({ data: st.single ? rows[0] ?? null : rows, error: null });
        }, reject);
      },
    };
    return b;
  };
  return { auth: {}, from: (t: string) => chain(t), rpc: () => { throw new Error('not used'); } };
}

describe.skipIf(!DB_URL)('TABLE/SETOF rpcs, filtered SDK writes and policies.all (real Postgres)', () => {
  let cwd: string;
  let previousCwd: string;

  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock(727274)');
    await resetDatabase();
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-rpc-table-'));
    process.chdir(cwd);
  }, 600_000);

  afterAll(async () => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
    await resetDatabase().catch(() => {});
    await admin?.end();
  });

  it('imports a TABLE-returning definer function with args, pushes it and it stays callable', async () => {
    await admin.query(FIXTURE);
    await admin.query(`INSERT INTO bookings (client_id, slug, services) VALUES ('${ALICE}', 'a-1', '["cut"]'), ('${BOB}', 'b-1', '[]')`);

    expect((await cli('init', '--yes', '--no-agents', '--db-url', DB_URL!)).code).toBe(0);
    const schemaPath = join(cwd, 'accessnexus.schema.ts');
    const source = readFileSync(schemaPath, 'utf-8');
    expect(source).toContain("args: { p_client_id: 'uuid' },\n      returns: { table: { booking_id: 'uuid', date_time: 'timestamptz', services: 'json', has_review: 'boolean' } },");
    expect(source).toContain("args: { p_from: 'timestamptz' },\n      returns: { setof: 'bookings' },");
    writeFileSync(schemaPath, source.replace("from 'accessnexus'", `from '${SRC_INDEX}'`));

    const validate = await cli('validate');
    expect(validate.json.issues?.filter((i: any) => i.severity === 'error') ?? []).toEqual([]);
    expect((await cli('generate')).code).toBe(0);

    // Push over the existing database: the replace guard keeps the unchanged functions.
    const oidBefore = (await admin.query(`SELECT 'get_client_bookings(uuid)'::regprocedure::oid AS oid`)).rows[0].oid;
    // The source policies were imported as rules; drop the originals (reviewed above).
    const push = await cli('push', '--replace-foreign-policies');
    expect(push.json.error ?? null).toBeNull();
    expect(push.code).toBe(0);
    const oidAfter = (await admin.query(`SELECT 'get_client_bookings(uuid)'::regprocedure::oid AS oid`)).rows[0].oid;
    expect(oidAfter).toBe(oidBefore);

    const mine = await asUser(ALICE, `SELECT * FROM get_client_bookings($1)`, [ALICE]);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ services: ['cut'], has_review: false });
    expect((await asUser(BOB, `SELECT * FROM get_client_bookings($1)`, [ALICE])).rows).toEqual([]);
    await expect(asUser(null, `SELECT * FROM get_client_bookings($1)`, [ALICE])).rejects.toThrow(/permission denied/);
    expect((await asUser(ALICE, `SELECT slug FROM bookings_after('2000-01-01')`)).rows).toEqual([{ slug: 'a-1' }]);

    // The SDK types the call: args required and typed, rows typed.
    const clientPath = findFile(cwd, 'client.ts')!;
    const typesPath = findFile(cwd, 'types.ts')!;
    const fixture = mkdtempSync(join(resolve(__dirname, '../../node_modules/.cache'), 'accessnexus-rpc-table-'));
    try {
      writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
      writeFileSync(join(fixture, 'client.ts'), readFileSync(clientPath, 'utf-8'));
      writeFileSync(join(fixture, 'types.ts'), readFileSync(typesPath, 'utf-8'));
      writeFileSync(join(fixture, 'use.ts'), `
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient, type Json } from './client.js';
import type { Database, Bookings } from './types.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
const db = createAccessNexusClient(createClient<Database>('http://x', 'k'));
export async function run(p_client_id: string) {
  const { data } = await db.rpc.get_client_bookings({ p_client_id });
  assertType<Equal<typeof data, { booking_id: string; date_time: string; services: Json; has_review: boolean }[] | null>>(true);
  const after = await db.rpc.bookings_after({ p_from: '2020-01-01' });
  assertType<Equal<typeof after.data, Bookings[] | null>>(true);
  // @ts-expect-error p_client_id is a string
  await db.rpc.get_client_bookings({ p_client_id: 1 });
  // @ts-expect-error p_client_id is required
  await db.rpc.get_client_bookings({});
  const upd = await db.bookings.updateOne({ slug: 'a-1' }, { reviewed: true }, { columns: ['id', 'reviewed'] });
  assertType<Equal<typeof upd.data, Pick<Bookings, 'id' | 'reviewed'> | null>>(true);
}
`);
      expect(typecheck(join(fixture, 'use.ts'))).toEqual([]);

      // updateOne by a unique non-PK column, under RLS, in one statement.
      const js = ts.transpileModule(readFileSync(clientPath, 'utf-8'), {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      writeFileSync(join(fixture, 'client.mjs'), js);
      const { createAccessNexusClient } = await import(pathToFileURL(join(fixture, 'client.mjs')).href);
      const statements: string[] = [];
      const alice = createAccessNexusClient(restStandIn(ALICE, statements));
      const res = await alice.bookings.updateOne({ slug: 'a-1' }, { reviewed: true }, { columns: ['slug', 'reviewed'] });
      expect(res).toEqual({ data: { slug: 'a-1', reviewed: true }, error: null });
      expect(statements).toEqual(['UPDATE bookings SET reviewed = $2 WHERE slug = $1 RETURNING slug, reviewed']);
      // Bob cannot see (so cannot update) Alice's booking: data null, row unchanged.
      const bob = createAccessNexusClient(restStandIn(BOB, []));
      expect(await bob.bookings.updateOne({ slug: 'a-1' }, { reviewed: false })).toEqual({ data: null, error: null });
      expect((await admin.query(`SELECT reviewed FROM bookings WHERE slug = 'a-1'`)).rows[0].reviewed).toBe(true);
      expect(() => alice.bookings.updateMany({}, { reviewed: false })).toThrow(/at least one column/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }

    // Changing the TABLE columns: the guard drops and recreates it in the same push.
    const changed = readFileSync(schemaPath, 'utf-8')
      .replace("has_review: 'boolean' } },", "has_review: 'boolean', slug: 'text' } },")
      .replace('SELECT b.id, b.date_time, b.services, b.reviewed FROM', 'SELECT b.id, b.date_time, b.services, b.reviewed, b.slug FROM');
    expect(changed).not.toBe(readFileSync(schemaPath, 'utf-8'));
    writeFileSync(schemaPath, changed);
    expect((await cli('generate')).code).toBe(0);
    const repush = await cli('push');
    expect(repush.json.error ?? null).toBeNull();
    expect(repush.code).toBe(0);
    const result = (await admin.query(`SELECT pg_get_function_result('get_client_bookings(uuid)'::regprocedure) AS r`)).rows[0].r;
    expect(result).toBe('TABLE(booking_id uuid, date_time timestamp with time zone, services json, has_review boolean, slug text)');
    expect((await asUser(ALICE, `SELECT slug FROM get_client_bookings($1)`, [ALICE])).rows).toEqual([{ slug: 'a-1' }]);
    // Still a definer RPC closed to anon after the DROP + CREATE.
    await expect(asUser(null, `SELECT * FROM get_client_bookings($1)`, [ALICE])).rejects.toThrow(/permission denied/);
  }, 180_000);

  it('policies.all creates four owner-only policies, with an override', async () => {
    await resetDatabase();
    // A fresh project directory (own migration history) for the new schema.
    const dir = mkdtempSync(join(tmpdir(), 'accessnexus-policies-all-'));
    process.chdir(dir);
    writeFileSync(join(dir, 'accessnexus.schema.ts'), `import { defineSchema, table, policy } from '${SRC_INDEX}';
export default defineSchema({
  notes: table({
    columns: { id: { type: 'uuid', default: 'gen_random_uuid()' }, user_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    policies: { all: policy.isOwner('user_id'), delete: policy.none() },
  }),
});
`);
    expect((await cli('generate')).code).toBe(0);
    const push = await cli('push');
    expect(push.json.error ?? null).toBeNull();
    expect(push.code).toBe(0);

    const policies = (await admin.query(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'notes' ORDER BY policyname`)).rows;
    expect(policies.map((p: any) => p.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);

    await asUser(ALICE, `INSERT INTO notes (user_id, body) VALUES ($1, 'mine')`, [ALICE]);
    await expect(asUser(BOB, `INSERT INTO notes (user_id, body) VALUES ($1, 'forged')`, [ALICE])).rejects.toThrow(/row-level security/);
    await expect(asUser(null, `INSERT INTO notes (user_id, body) VALUES ($1, 'anon')`, [ALICE])).rejects.toThrow(/permission denied|row-level security/);
    expect((await asUser(ALICE, `SELECT body FROM notes`)).rows).toEqual([{ body: 'mine' }]);
    expect((await asUser(BOB, `SELECT body FROM notes`)).rows).toEqual([]);
    expect((await asUser(null, `SELECT body FROM notes`).catch(() => ({ rows: [] }))).rows).toEqual([]);
    expect((await asUser(BOB, `UPDATE notes SET body = 'x'`)).rowCount).toBe(0);
    await expect(asUser(ALICE, `UPDATE notes SET user_id = $1`, [BOB])).rejects.toThrow(/row-level security/);
    expect((await asUser(ALICE, `UPDATE notes SET body = 'edited'`)).rowCount).toBe(1);
    // delete: policy.none() overrides all: even the owner cannot delete.
    expect((await asUser(ALICE, `DELETE FROM notes`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT body FROM notes`)).rows).toEqual([{ body: 'edited' }]);
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
