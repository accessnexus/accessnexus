// Live-database change plan (`diff --against-db`, `push --dry-run` with a URL)
// against a real Supabase Postgres. Skipped unless ACCESSNEXUS_TEST_DB_URL is
// set — see push.integration.test.ts for the docker + auth.jwt() setup.
//
// The tests DROP every table in the public schema of that database.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');

let pg: any;
let admin: any;
let cwd: string;
let previousCwd: string;

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

/** Everything in `public` a plan could touch, as one comparable string. */
async function catalogFingerprint(): Promise<string> {
  const { rows } = await admin.query(`
    SELECT string_agg(x, E'\\n' ORDER BY x) AS fp FROM (
      SELECT 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity || ' ' || coalesce(c.relacl::text, '')
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'col ' || a.attrelid::regclass || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'pol ' || p.polname || ' ' || p.polroles::text || ' ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'fn ' || pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '')
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f'
      UNION ALL
      SELECT 'trg ' || t.tgname || ' ' || pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ) s(x)`);
  return String(rows[0].fp ?? '');
}

async function migrationsTableAbsent(): Promise<boolean> {
  return (await admin.query(`SELECT to_regclass('public.accessnexus_migrations') IS NULL AS absent`)).rows[0].absent;
}

async function migrationRows(): Promise<number> {
  return Number((await admin.query('SELECT count(*) AS n FROM public.accessnexus_migrations')).rows[0].n);
}

async function lockIsFree(): Promise<boolean> {
  const { rows } = await admin.query(`SELECT pg_try_advisory_lock(hashtext('accessnexus_push_lock')) AS ok`);
  if (rows[0].ok) await admin.query(`SELECT pg_advisory_unlock(hashtext('accessnexus_push_lock'))`);
  return rows[0].ok;
}

async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const needsDb = argv[0] === 'push' || argv.includes('--against-db');
  const code = await runCli([...argv, '--json', ...(needsDb ? ['--url', DB_URL!] : [])]);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout) };
}

function writeSchema(body: string): void {
  writeFileSync(join(cwd, 'accessnexus.schema.ts'), `import { defineSchema, table, policy, rpc } from '${SRC_INDEX}';\n${body}`);
}

const notesSchema = (select = "policy.isOwner('owner_id')", rpcs = '') => `
export default defineSchema({
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    policies: { select: ${select}, insert: policy.isOwner('owner_id') },
  }),
}${rpcs ? `, { rpcs: { ${rpcs} } }` : ''});`;

const find = (plan: any, kind: string, object: string) =>
  plan.changes.find((c: any) => c.kind === kind && c.object === object);

describe.skipIf(!DB_URL)('live change plan against a real Supabase Postgres', () => {
  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    // Integration files share the database and reset it: serialize them.
    await admin.query('SELECT pg_advisory_lock(727274)');
  }, 600_000);

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase();
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-plan-it-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('fresh database: everything is added, and nothing persists', async () => {
    writeSchema(notesSchema(undefined, "note_count: rpc({ returns: 'int', language: 'sql', body: 'SELECT count(*)::int FROM public.notes;' })"));
    const before = await catalogFingerprint();

    const plan = await cli('diff', '--against-db');
    expect(plan.code).toBe(0);
    expect(plan.json.againstDb).toBe(true);
    expect(plan.json.persisted).toBe(false);
    expect(plan.json.failed).toBeNull();
    expect(plan.json.changed).toBe(true);
    expect(plan.json.changes.every((c: any) => c.change === 'added')).toBe(true);
    expect(plan.json.summary).toMatchObject({ modified: 0, removed: 0 });
    expect(find(plan.json, 'table', 'public.notes')).toBeDefined();
    expect(find(plan.json, 'rls', 'public.notes').after).toEqual({ enabled: true, forced: true });
    expect(find(plan.json, 'column', 'public.notes.body').after).toMatchObject({ type: 'text' });
    expect(find(plan.json, 'policy', 'public.notes.accessnexus_notes_select').after).toMatchObject({
      command: 'SELECT', roles: ['authenticated'], permissive: true,
    });
    expect(find(plan.json, 'function', 'public.note_count()').after).toMatchObject({
      volatility: 'VOLATILE', config: ['search_path=pg_catalog, public'], securityDefiner: false,
    });
    expect(plan.json.riskyChanges).toEqual([]);
    expect(plan.json.wouldApply.length).toBeGreaterThan(0);

    // Nothing persisted: same catalog, no bookkeeping table, lock released.
    expect(await catalogFingerprint()).toBe(before);
    expect(await migrationsTableAbsent()).toBe(true);
    expect(await lockIsFree()).toBe(true);

    // --check: changes → exit 1 with the plan in the payload.
    const check = await cli('diff', '--against-db', '--check');
    expect(check.code).toBe(1);
    expect(check.json.error.code).toBe('LIVE_DB_CHANGES');
    expect(check.json.changes.length).toBe(plan.json.changes.length);
  }, 60_000);

  it('database matching the schema: no changes, and push --dry-run carries the same plan', async () => {
    writeSchema(notesSchema());
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const rows = await migrationRows();
    const before = await catalogFingerprint();

    const plan = await cli('diff', '--against-db', '--check');
    expect(plan.code).toBe(0);
    expect(plan.json.generatedUpToDate).toBe(true);
    expect(plan.json.changed).toBe(false);
    expect(plan.json.changes).toEqual([]);
    expect(plan.json.wouldApply).toEqual([]);

    const dry = await cli('push', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.json.livePlan.changed).toBe(false);
    expect(dry.json.wouldRefuse).toBe(false);

    expect(await catalogFingerprint()).toBe(before);
    expect(await migrationRows()).toBe(rows);
  }, 60_000);

  it('policy expression change: shows the USING clause before → after', async () => {
    writeSchema(notesSchema());
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const rows = await migrationRows();

    writeSchema(notesSchema('policy.isAuthenticated()'));
    const plan = await cli('diff', '--against-db');
    expect(plan.code).toBe(0);
    expect(plan.json.generatedUpToDate).toBe(false);
    const change = find(plan.json, 'policy', 'public.notes.accessnexus_notes_select');
    expect(change.change).toBe('modified');
    expect(change.fields).toContain('using');
    expect(change.before.using).toContain('owner_id');
    expect(change.after.using).not.toContain('owner_id');
    expect(plan.json.changes.filter((c: any) => c.kind === 'policy')).toHaveLength(1);

    // push --dry-run rehearses the files on disk (generate first).
    expect((await cli('generate')).code).toBe(0);
    const dry = await cli('push', '--dry-run');
    expect(find(dry.json.livePlan, 'policy', 'public.notes.accessnexus_notes_select').fields).toContain('using');
    expect(await migrationRows()).toBe(rows);
  }, 60_000);

  it('a STABLE function with its own config in the database vs the generated VOLATILE one: modified + risky', async () => {
    await admin.query(`
      CREATE FUNCTION public.note_count() RETURNS integer LANGUAGE sql STABLE SET search_path = public SET work_mem = '64MB'
        AS $$ SELECT 1 $$;
    `);
    writeSchema(notesSchema(undefined, "note_count: rpc({ returns: 'int', language: 'sql', body: 'SELECT 1;' })"));
    const plan = await cli('diff', '--against-db');
    expect(plan.code).toBe(0);
    const change = find(plan.json, 'function', 'public.note_count()');
    expect(change.change).toBe('modified');
    expect(change.fields).toEqual(expect.arrayContaining(['volatility', 'config']));
    expect(change.before.volatility).toBe('STABLE');
    expect(change.after.volatility).toBe('VOLATILE');
    const codes = plan.json.riskyChanges.map((r: any) => r.code);
    expect(codes).toContain('function_volatility_changed');
    expect(codes).toContain('function_config_changed');
    // The real function is untouched.
    const { rows } = await admin.query(`SELECT provolatile FROM pg_proc WHERE oid = 'public.note_count()'::regprocedure`);
    expect(rows[0].provolatile).toBe('s');
  }, 60_000);

  it('foreign policies: a blocker by default, a listed (risky) drop with --replace-foreign-policies', async () => {
    await admin.query(`
      CREATE TABLE public.notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid, body text);
      ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "anyone can read" ON public.notes FOR SELECT USING (true);
    `);
    writeSchema(notesSchema());
    const before = await catalogFingerprint();

    const refused = await cli('diff', '--against-db');
    expect(refused.code).toBe(0);
    expect(refused.json.blockers.map((b: any) => b.code)).toEqual(['FOREIGN_POLICIES']);
    expect(find(refused.json, 'policy', 'public.notes.anyone can read')).toBeUndefined();

    const replaced = await cli('diff', '--against-db', '--replace-foreign-policies');
    expect(replaced.json.blockers).toEqual([]);
    expect(replaced.json.droppedPolicies.map((p: any) => p.policy)).toEqual(['anyone can read']);
    const dropped = find(replaced.json, 'policy', 'public.notes.anyone can read');
    expect(dropped.change).toBe('removed');
    expect(dropped.before).toMatchObject({ command: 'SELECT', using: 'true', roles: ['public'] });
    expect(replaced.json.riskyChanges).toContainEqual(expect.objectContaining({ code: 'policy_dropped', object: 'public.notes.anyone can read' }));

    expect(await catalogFingerprint()).toBe(before);
    expect(await migrationsTableAbsent()).toBe(true);
  }, 60_000);

  it('a push that would fail: reports the file and the SQL error, database unchanged', async () => {
    writeSchema(notesSchema(undefined, "broken: rpc({ returns: 'int', language: 'sql', body: 'SELECT count(*)::int FROM table_that_does_not_exist;' })"));
    const before = await catalogFingerprint();

    const plan = await cli('diff', '--against-db');
    expect(plan.code).toBe(1);
    expect(plan.json.error.code).toBe('PUSH_WOULD_FAIL');
    expect(plan.json.error.message).toContain('table_that_does_not_exist');
    expect(plan.json.failed.file).toMatch(/rpcs/);
    expect(plan.json.failed.code).toBe('PUSH_FAILED');
    expect(plan.json.failed.sqlState).toBe('42P01');
    expect(plan.json.persisted).toBe(false);

    expect(await catalogFingerprint()).toBe(before);
    expect(await migrationsTableAbsent()).toBe(true);
    expect(await lockIsFree()).toBe(true);
  }, 60_000);
});
