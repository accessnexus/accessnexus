// Faithful import of function EXECUTE grants through `init --db-url` ->
// `diff --against-db` -> `push` against a real Supabase Postgres: a definer
// helper anon could execute (via PUBLIC) keeps anon, one it could not stays
// revoked, and the live plan judges grants on EFFECTIVE access.
//
// Skipped unless ACCESSNEXUS_TEST_DB_URL points at a disposable database (see
// the header of push.integration.test.ts for the docker + auth.jwt() setup).
// The test DROPS every table and function in the public schema.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');

const FIXTURE = `
CREATE TABLE public.orgs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE public.members (org_id uuid NOT NULL REFERENCES public.orgs(id), user_id uuid NOT NULL, PRIMARY KEY (org_id, user_id));

-- Helper called by a TO public policy; anon can execute it only via PUBLIC.
CREATE FUNCTION public.is_member(p_org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.members m WHERE m.org_id = p_org AND m.user_id = (SELECT auth.uid())) $$;
REVOKE EXECUTE ON FUNCTION public.is_member(uuid) FROM anon, authenticated;

-- Same shape; the maintainer decides it should not stay public (allowAnon removed).
CREATE FUNCTION public.open_stats() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$ SELECT count(*) FROM public.orgs $$;
REVOKE EXECUTE ON FUNCTION public.open_stats() FROM anon, authenticated;

-- Maintenance function neither anon nor authenticated could execute.
CREATE FUNCTION public.admin_reset() RETURNS integer LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$ SELECT 1 $$;
REVOKE EXECUTE ON FUNCTION public.admin_reset() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_read ON public.orgs FOR SELECT TO public USING (public.is_member(id));
CREATE POLICY members_read ON public.members FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.orgs, public.members TO anon, authenticated;
INSERT INTO public.orgs (name) VALUES ('acme');
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
    END $$;
  `);
}

async function asAnon(sql: string): Promise<{ rows: any[]; error: string | null }> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE anon');
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    const result = await client.query(sql);
    return { rows: result.rows, error: null };
  } catch (err: any) {
    return { rows: [], error: String(err.message) };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await runCli([...argv, '--json']);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout) };
}

describe.skipIf(!DB_URL)('function EXECUTE grants through init / diff --against-db / push', () => {
  let cwd: string;
  let previousCwd: string;

  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    // Integration files share the database and reset it: run one at a time.
    await admin.query('SELECT pg_advisory_lock(727274)');
    await resetDatabase();
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-grants-'));
    process.chdir(cwd);
  }, 600_000);

  afterAll(async () => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
    await resetDatabase().catch(() => {});
    await admin?.end();
  });

  it('keeps anon where the source allowed it, keeps it revoked where it did not, and plans on effective access', async () => {
    await admin.query(FIXTURE);
    // Source behavior: anon reads 0 rows (no error) and can call the helper.
    expect(await asAnon('SELECT * FROM public.orgs')).toEqual({ rows: [], error: null });
    expect((await asAnon(`SELECT public.is_member(gen_random_uuid()) AS m`)).error).toBeNull();
    expect((await asAnon('SELECT public.admin_reset()')).error).toMatch(/permission denied/);

    const init = await cli('init', '--yes', '--no-agents', '--db-url', DB_URL!);
    expect(init.code).toBe(0);
    expect(init.json.anonExecutableFunctions).toEqual(['is_member', 'open_stats']);
    // rpc() always grants authenticated: init says so for admin_reset.
    expect(init.json.authenticatedGrantedFunctions).toEqual(['admin_reset']);

    const schemaPath = join(cwd, 'accessnexus.schema.ts');
    let source = readFileSync(schemaPath, 'utf-8');
    expect(source).toMatch(/is_member: rpc\(\{[\s\S]*?\/\/ NOTE: anon could execute this in the source database[^\n]*\n\s+allowAnon: true,/);
    expect(source).not.toMatch(/admin_reset: rpc\(\{[^}]*allowAnon/);
    // The maintainer decides open_stats must not stay public.
    source = source.replace(/(open_stats: rpc\(\{[\s\S]*?)\n\s+\/\/ NOTE: anon could execute[^\n]*\n\s+allowAnon: true,/, '$1');
    expect(source).not.toMatch(/open_stats: rpc\(\{[^}]*allowAnon/);
    writeFileSync(schemaPath, source.replace("from 'accessnexus'", `from '${SRC_INDEX}'`));
    expect((await cli('generate')).code).toBe(0);

    const plan = await cli('diff', '--against-db', '--replace-foreign-policies', '--url', DB_URL!);
    expect(plan.json.failed).toBeNull();
    const risky = plan.json.riskyChanges as Array<{ code: string; object: string; message: string }>;
    const grantRisks = risky.filter((r) => r.code.startsWith('grant_'));
    // anon: via PUBLIC -> direct grant on is_member is not a widening (nor a narrowing).
    expect(grantRisks.filter((r) => r.object.includes('is_member'))).toEqual([]);
    const isMember = plan.json.changes.find((c: any) => c.kind === 'grant' && c.object === 'function public.is_member(p_org uuid)');
    expect(isMember.notes).toContain('anon EXECUTE: via PUBLIC → direct grant (no change in access)');
    // open_stats loses anon: grant_narrowed.
    const narrowed = grantRisks.filter((r) => r.code === 'grant_narrowed');
    expect(narrowed.map((r) => r.object)).toEqual(['function public.open_stats()']);
    expect(narrowed[0].message).toContain('anon EXECUTE: via PUBLIC → none');
    // admin_reset: authenticated gains EXECUTE (the source revoked it): flagged, anon untouched.
    const adminRisk = grantRisks.filter((r) => r.object.includes('admin_reset'));
    expect(adminRisk.map((r) => r.code)).toEqual(['grant_widened']);
    expect(adminRisk[0].message).toContain('authenticated EXECUTE: none → direct grant');
    expect(adminRisk[0].message).not.toContain('anon');

    // Push onto the source database itself (the adoption path).
    const push = await cli('push', '--url', DB_URL!, '--replace-foreign-policies');
    expect(push.json.error?.message ?? null).toBeNull();
    expect(push.code).toBe(0);

    // After push: anonymous SELECT still returns 0 rows (no permission error),
    // anon can call the helper, and the functions anon could not run stay revoked.
    expect(await asAnon('SELECT * FROM public.orgs')).toEqual({ rows: [], error: null });
    expect((await asAnon(`SELECT public.is_member(gen_random_uuid()) AS m`)).error).toBeNull();
    expect((await asAnon('SELECT public.admin_reset()')).error).toMatch(/permission denied/);
    expect((await asAnon('SELECT public.open_stats()')).error).toMatch(/permission denied/);
  }, 120_000);
});
