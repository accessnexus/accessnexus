import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

// `accessnexus migration discard`: drop the newest migration when no database
// applied it, restore the snapshot to the state before it, regenerate.

const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');
const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const DB_ENV = ['ACCESSNEXUS_DB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL'];

let cwd: string;
let previousCwd: string;
const savedEnv: Record<string, string | undefined> = {};

async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await runCli([...argv, '--json']);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout) };
}

const schema = (extra = '') => `
import { defineSchema, table, policy } from '${SRC_INDEX}';
export default defineSchema({
  notes: table({ columns: { id: 'uuid', body: 'text'${extra} }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
});`;
const writeSchema = (extra = '') => writeFileSync(join(cwd, 'accessnexus.schema.ts'), schema(extra));
const migrations = () => readdirSync(join(cwd, 'generated', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const snapshot = () => JSON.parse(readFileSync(join(cwd, 'generated', 'migrations', '.snapshot.json'), 'utf-8'));
const tick = () => new Promise((r) => setTimeout(r, 1100)); // migration file names have second resolution

beforeAll(() => {
  for (const key of DB_ENV) { savedEnv[key] = process.env[key]; delete process.env[key]; }
});
afterAll(() => {
  for (const key of DB_ENV) { if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]; }
});
beforeEach(() => {
  previousCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'accessnexus-discard-'));
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe('migration discard (no database)', () => {
  it('keeps a history of states and restores the previous one', async () => {
    writeSchema();
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    const [init] = migrations();
    await tick();
    writeSchema(", title: 'text?'");
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    const [, second] = migrations();
    expect(snapshot().lastMigrationFile).toBe(second);
    expect(snapshot().history.map((h: any) => h.lastMigrationFile)).toEqual([init]);

    // Without a database URL discard refuses unless --force.
    const refused = await cli('migration', 'discard');
    expect(refused.code).toBe(1);
    expect(refused.json.error.code).toBe('MIGRATION_DISCARD_NEEDS_DB');
    expect(migrations()).toEqual([init, second]);

    // discard only discards: nothing is regenerated, even though the schema still differs.
    const discarded = await cli('migration', 'discard', '--force');
    expect(discarded.code).toBe(0);
    expect(discarded.json).toMatchObject({ discarded: `generated/migrations/${second}`, restoredTo: `generated/migrations/${init}`, checkedDatabase: null, regenerated: null });
    expect(migrations()).toEqual([init]);
    expect(snapshot().lastMigrationFile).toBe(init);
    expect(snapshot().history).toBeUndefined();

    // amend = discard + generate, and says which file it wrote.
    await tick();
    const regenerated = await cli('migration', 'amend', '--force');
    expect(regenerated.code).toBe(0);
    expect(regenerated.json.discarded).toBe(`generated/migrations/${init}`);
    expect(regenerated.json.restoredTo).toBeNull();
    expect(regenerated.json.regenerated).toMatch(/^generated\/migrations\/\d{14}__init\.sql$/);
    // The init itself was discarded: generate wrote a fresh __init with the title column.
    const [fresh] = migrations();
    expect(fresh).toMatch(/__init\.sql$/);
    expect(readFileSync(join(cwd, 'generated', 'migrations', fresh), 'utf-8')).toContain('title TEXT');
  }, 30_000);

  it('refuses when the snapshot predates the history (nothing deleted)', async () => {
    writeSchema();
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    await tick();
    writeSchema(", title: 'text?'");
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    const snapPath = join(cwd, 'generated', 'migrations', '.snapshot.json');
    const { history: _history, ...old } = snapshot();
    writeFileSync(snapPath, JSON.stringify(old));
    const res = await cli('migration', 'discard', '--force');
    expect(res.code).toBe(1);
    expect(res.json.error.code).toBe('MIGRATION_HISTORY_MISSING');
    expect(migrations()).toHaveLength(2);
  }, 30_000);

  it('reports when there is nothing to discard, and rejects unknown subcommands', async () => {
    writeSchema();
    expect((await cli('migration', 'discard', '--force')).json.error.code).toBe('NO_MIGRATION_TO_DISCARD');
    expect((await cli('migration', 'drop')).json.error.code).toBe('UNKNOWN_COMMAND');
  });
});

describe.skipIf(!DB_URL)('migration discard against a real database', () => {
  let admin: any;
  beforeAll(async () => {
    let pg: any = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock(727274)');
  });
  afterAll(async () => { await admin?.end(); });

  it('discards a pending migration and refuses an applied one', async () => {
    await admin.query(`DROP TABLE IF EXISTS public.notes CASCADE; DROP TABLE IF EXISTS public.accessnexus_migrations;`);
    writeSchema();
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    const first = await cli('push', '--url', DB_URL!);
    expect(first.code).toBe(0);
    await tick();
    writeSchema(", org_id: 'uuid'");
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    const pending = migrations()[1];

    // Pending: discarded after checking the database, then regenerated (nullable now).
    writeSchema(", org_id: 'uuid?'");
    await tick();
    const res = await cli('migration', 'amend', '--url', DB_URL!, '--sql-only');
    expect(res.code).toBe(0);
    expect(res.json.discarded).toBe(`generated/migrations/${pending}`);
    expect(res.json.checkedDatabase).toContain('127.0.0.1');
    expect(res.json.regenerated).toMatch(/__changes\.sql$/);
    const [, replacement] = migrations();
    expect(replacement).not.toBe(pending);
    expect(readFileSync(join(cwd, 'generated', 'migrations', replacement), 'utf-8')).toMatch(/org_id UUID;/);

    // Applied: refused, nothing touched.
    expect((await cli('push', '--url', DB_URL!)).code).toBe(0);
    const applied = await cli('migration', 'discard', '--url', DB_URL!);
    expect(applied.code).toBe(1);
    expect(applied.json.error.code).toBe('MIGRATION_ALREADY_APPLIED');
    expect(existsSync(join(cwd, 'generated', 'migrations', replacement))).toBe(true);
  }, 60_000);

  it('recipe: a required tenant column on a table with rows (nullable → data migration backfill → NOT NULL)', async () => {
    await admin.query(`DROP TABLE IF EXISTS public.notes CASCADE; DROP TABLE IF EXISTS public.accessnexus_migrations;`);
    writeSchema();
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    expect((await cli('push', '--url', DB_URL!)).code).toBe(0);
    await admin.query(`INSERT INTO notes (id, body) VALUES (gen_random_uuid(), 'a'), (gen_random_uuid(), 'b')`);

    // 1. nullable column
    await tick();
    writeSchema(", org_id: 'uuid?'");
    expect((await cli('generate', '--sql-only')).code).toBe(0);
    // 2. data migration with the backfill
    await tick();
    const data = await cli('migration', 'data', 'backfill_note_org');
    expect(data.code).toBe(0);
    expect(data.json.created).toMatch(/^generated\/migrations\/data\/\d{14}__backfill_note_org\.sql$/);
    writeFileSync(join(cwd, data.json.created), `UPDATE public.notes SET org_id = '00000000-0000-0000-0000-0000000000aa' WHERE org_id IS NULL;\n`);
    // 3. required
    await tick();
    writeSchema(", org_id: 'uuid'");
    const gen = await cli('generate', '--sql-only');
    expect(gen.code).toBe(0);
    expect(gen.json.warnings.map((w: any) => w.code)).not.toContain('NOT_NULL_COLUMN_ADDED');

    const plan = await cli('diff', '--against-db', '--url', DB_URL!, '--sql-only');
    expect(plan.json.riskyChanges.map((r: any) => r.code)).toEqual([]); // org_id is new in the database: added NOT NULL
    const push = await cli('push', '--url', DB_URL!);
    expect(push.code).toBe(0);
    const applied = push.json.applied.filter((f: string) => f.includes('migrations'));
    expect(applied).toHaveLength(3);
    expect(applied[1]).toBe(data.json.created); // between the two schema migrations
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM notes WHERE org_id = '00000000-0000-0000-0000-0000000000aa'`);
    expect(rows[0].n).toBe(2);
    const col = await admin.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'org_id'`);
    expect(col.rows[0].is_nullable).toBe('NO');
    // Applied data migrations are immutable like the others.
    writeFileSync(join(cwd, data.json.created), `UPDATE public.notes SET body = 'x';\n`);
    expect((await cli('push', '--url', DB_URL!)).json.error.code).toBe('MIGRATION_DRIFT');
  }, 60_000);
});


describe('test-db (without Docker)', () => {
  it('rejects unknown actions and reports a missing docker binary', async () => {
    expect((await cli('test-db', 'start')).json.error.code).toBe('UNKNOWN_COMMAND');
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const res = await cli('test-db', 'up', '--port', '55999');
      expect(res.code).toBe(1);
      expect(res.json.error.code).toBe('DOCKER_NOT_FOUND');
    } finally {
      process.env.PATH = path;
    }
    expect((await cli('test-db', 'up', '--port', 'abc')).json.error.code).toBe('INVALID_FLAG_VALUE');
  });
});

describe('test-db port check', () => {
  it('refuses a port something already listens on (TEST_DB_PORT_IN_USE)', async () => {
    const { createServer } = await import('node:net');
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await cli('test-db', 'up', '--port', String(port), '--name', 'accessnexus-port-check');
      expect(res.code).toBe(1);
      expect(['TEST_DB_PORT_IN_USE', 'DOCKER_NOT_FOUND']).toContain(res.json.error.code);
    } finally {
      server.close();
    }
  });
});
