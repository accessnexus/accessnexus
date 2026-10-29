// Round trip of function volatility and configuration (pg_proc.provolatile /
// proconfig) through `init --db-url` -> generate -> push against a real
// Supabase Postgres, plus the search_path hardening init reports.
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
CREATE TABLE public.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  note text
);

CREATE FUNCTION public.f_stable() RETURNS integer LANGUAGE sql STABLE
  SET search_path TO pg_catalog, public AS $$ SELECT count(*)::int FROM public.items $$;

CREATE FUNCTION public.f_immutable(x integer) RETURNS integer LANGUAGE sql IMMUTABLE
  SET search_path TO pg_catalog, public AS $$ SELECT x * 2 $$;

CREATE FUNCTION public.f_rowsec() RETURNS bigint LANGUAGE sql SECURITY DEFINER
  SET row_security TO 'off' SET work_mem TO '64MB' AS $$ SELECT count(*) FROM public.items $$;

CREATE FUNCTION public.f_pub() RETURNS integer LANGUAGE plpgsql
  SET search_path TO 'public' AS $$ BEGIN RETURN 1; END; $$;

CREATE FUNCTION public.items_note() RETURNS trigger LANGUAGE plpgsql
  SET row_security TO 'off' AS $$ BEGIN NEW.note := 'n:' || NEW.name; RETURN NEW; END; $$;

CREATE TRIGGER items_note BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.items_note();
`;

const PROC_SQL = `
  SELECT p.proname AS name, p.provolatile::text AS vol, coalesce(p.proconfig, '{}')::text[] AS config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  ORDER BY 1`;

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

async function procs(): Promise<Record<string, { vol: string; config: string[] }>> {
  const rows = (await admin.query(PROC_SQL)).rows as Array<{ name: string; vol: string; config: string[] }>;
  return Object.fromEntries(rows.map((r) => [r.name, { vol: r.vol, config: [...r.config].sort() }]));
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

describe.skipIf(!DB_URL)('function volatility / config round trip against a real Supabase Postgres', () => {
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
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-fnfidelity-'));
    process.chdir(cwd);
  }, 600_000);

  afterAll(async () => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
    await resetDatabase().catch(() => {});
    await admin?.end();
  });

  it('keeps STABLE/IMMUTABLE and proconfig, and reports the search_path it hardens', async () => {
    await admin.query(FIXTURE);
    const before = await procs();
    expect(before.f_stable.vol).toBe('s');

    const init = await cli('init', '--yes', '--no-agents', '--db-url', DB_URL!);
    expect(init.code).toBe(0);
    const hardened = init.json.hardenedFunctions as Array<{ kind: string; name: string; from: string | null; to: string }>;
    expect(hardened).toEqual(expect.arrayContaining([
      { kind: 'rpc', name: 'f_pub', from: 'public', to: 'pg_catalog, public' },
      { kind: 'rpc', name: 'f_rowsec', from: null, to: 'pg_catalog, public' },
      { kind: 'trigger', name: 'items.items_note', from: null, to: 'pg_catalog, public' },
    ]));
    expect(hardened.map((h) => h.name)).not.toContain('f_stable');
    expect(hardened.map((h) => h.name)).not.toContain('f_immutable');
    expect(hardened).toHaveLength(3);

    const schemaPath = join(cwd, 'accessnexus.schema.ts');
    const source = readFileSync(schemaPath, 'utf-8');
    expect(source).toContain("volatility: 'stable',");
    expect(source).toContain("volatility: 'immutable',");
    expect(source).toContain("set: { row_security: 'off', work_mem: '64MB' },");
    expect(source).toContain("// NOTE: search_path was 'public'; generate pins SET search_path = pg_catalog, public");
    writeFileSync(schemaPath, source.replace("from 'accessnexus'", `from '${SRC_INDEX}'`));

    const validate = await cli('validate');
    expect(validate.json.issues?.filter((i: any) => i.severity === 'error') ?? []).toEqual([]);
    expect((await cli('generate')).code).toBe(0);

    await resetDatabase();
    const push = await cli('push', '--url', DB_URL!);
    expect(push.json.error ?? null).toBeNull();
    expect(push.code).toBe(0);

    const after = await procs();
    const pinned = 'search_path=pg_catalog, public';
    expect(after.f_stable).toEqual({ vol: 's', config: [pinned] });
    expect(after.f_immutable).toEqual({ vol: 'i', config: [pinned] });
    expect(after.f_rowsec).toEqual({ vol: 'v', config: ['row_security=off', pinned, 'work_mem=64MB'] });
    expect(after.f_pub).toEqual({ vol: 'v', config: [pinned] });
    expect(after.accessnexus_items_items_note_fn.config).toEqual(['row_security=off', pinned]);

    // The functions still work.
    await admin.query(`INSERT INTO public.items (name) VALUES ('a')`);
    const r = await admin.query('SELECT f_stable() AS s, f_immutable(4) AS i, f_rowsec() AS c, f_pub() AS p, (SELECT note FROM items) AS note');
    expect(r.rows[0]).toEqual({ s: 1, i: 8, c: '1', p: 1, note: 'n:a' });
  }, 120_000);
});
