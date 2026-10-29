// Integration tests against a real Supabase Postgres. Skipped unless
// ACCESSNEXUS_TEST_DB_URL points at a disposable database, e.g.:
//
//   docker run -d --rm --name accessnexus-test-pg -e POSTGRES_PASSWORD=postgres \
//     -p 55439:5432 ghcr.io/supabase/postgres:15.19.0.007
//   ACCESSNEXUS_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:55439/postgres npx vitest run push.integration
//
//   docker exec accessnexus-test-pg psql -U supabase_admin -d postgres -c "CREATE OR REPLACE FUNCTION auth.jwt()
//     RETURNS jsonb LANGUAGE sql STABLE AS \$\$ SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
//     nullif(current_setting('request.jwt.claims', true), ''))::jsonb \$\$; GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated;
//     ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;"
//
// The tests DROP every table in the public schema of that database.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';
const DAVE = '44444444-4444-4444-4444-444444444444';
const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';

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
      -- Every user function in public (not the ones extensions own).
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
    DELETE FROM auth.users WHERE id IN ('${ALICE}', '${BOB}', '${CAROL}', '${DAVE}');
  `);
}

/** Run statements as an `authenticated` API user (what PostgREST does). */
async function asUser(
  userId: string | null,
  sql: string,
  opts: { appRole?: string; email?: string } = {},
): Promise<{ rows: any[]; rowCount: number }> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const claims = JSON.stringify({
      sub: userId,
      role: userId ? 'authenticated' : 'anon',
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.appRole ? { app_metadata: { role: opts.appRole } } : {}),
    });
    await client.query(`SET LOCAL ROLE ${userId ? 'authenticated' : 'anon'}`);
    await client.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [claims, userId ?? '']);
    const result = await client.query(sql);
    await client.query('COMMIT');
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Expect an API statement to be rejected by RLS / permissions. */
async function rejected(userId: string | null, sql: string, opts: { appRole?: string; email?: string } = {}): Promise<string> {
  try {
    await asUser(userId, sql, opts);
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error(`expected the statement to fail: ${sql}`);
}

async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const needsDb = argv[0] === 'push' || argv[0] === 'seed';
  const code = await runCli([...argv, '--json', ...(needsDb ? ['--url', DB_URL!] : [])]);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout) };
}

function writeSchema(body: string): void {
  writeFileSync(join(cwd, 'accessnexus.schema.ts'), `import { defineSchema, definePermissions, table, policy, trigger, rpc } from '${SRC_INDEX}';\n${body}`);
}

/** The ```ts block of llms.txt that contains `marker`, importing from this checkout. */
function llmsRecipe(marker: string): string {
  const llms = readFileSync(resolve(__dirname, '../../llms.txt'), 'utf-8');
  const block = [...llms.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes(marker));
  if (!block) throw new Error(`llms.txt has no ts block containing ${marker}`);
  return block.replaceAll("from 'accessnexus'", `from '${SRC_INDEX}'`);
}

describe.skipIf(!DB_URL)('push against a real Supabase Postgres', () => {
  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    // Integration files share the database and reset it: hold a session lock so
    // vitest's parallel files run one after another.
    await admin.query('SELECT pg_advisory_lock(727274)');
    // The bare Supabase image has auth.uid() but not auth.jwt() (GoTrue adds it).
    const { rows } = await admin.query(`SELECT to_regprocedure('auth.jwt()') IS NOT NULL AS ok`);
    if (!rows[0].ok) {
      throw new Error('auth.jwt() is missing: create it as supabase_admin (see the comment at the top of this file).');
    }
  }, 600_000);

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase();
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-it-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('pushes, skips unchanged files, re-applies a changed policy and refuses stale output', async () => {
    const notes = (select: string, extra = '') => `
export default defineSchema({
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text'${extra} },
    primaryKey: 'id',
    policies: { select: ${select}, insert: policy.isOwner('owner_id'), update: policy.isOwner('owner_id'), delete: policy.isOwner('owner_id') },
  }),
});`;
    writeSchema(notes(`policy.isOwner('owner_id')`));
    expect((await cli('generate')).code).toBe(0);

    const first = await cli('push');
    expect(first.code).toBe(0);
    expect(first.json.applied.length).toBeGreaterThan(0);

    const second = await cli('push');
    expect(second.code).toBe(0);
    expect(second.json.applied).toEqual([]);

    // Change only a policy: the policy file is re-applied (no unique violation).
    writeSchema(notes('policy.isAuthenticated()'));
    expect((await cli('generate')).code).toBe(0);
    const third = await cli('push');
    expect(third.code).toBe(0);
    expect(third.json.applied).toEqual(['generated/policies/notes_rls.sql']);
    const { rows } = await admin.query(`SELECT pg_get_expr(polqual, polrelid) AS q FROM pg_policy WHERE polname = 'accessnexus_notes_select'`);
    expect(rows[0].q).toContain('IS NOT NULL');

    // Removing a rule revokes it: the old policy is dropped, not left granting access.
    writeSchema(notes('policy.isAuthenticated()').replace(", delete: policy.isOwner('owner_id')", ''));
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const remaining = await admin.query(`SELECT polname FROM pg_policy WHERE polrelid = 'notes'::regclass ORDER BY polname`);
    expect(remaining.rows.map((r) => r.polname)).toEqual([
      'accessnexus_notes_insert', 'accessnexus_notes_select', 'accessnexus_notes_update',
    ]);

    // Schema changed but generate was not run: push refuses.
    writeSchema(notes('policy.isAuthenticated()', `, title: 'text?'`));
    const stale = await cli('push');
    expect(stale.code).toBe(1);
    expect(stale.json.error.code).toBe('GENERATED_OUT_OF_DATE');
  }, 60_000);

  it('refuses destructive migrations unless --allow-destructive', async () => {
    const schema = (columns: string) => `
export default defineSchema({
  notes: table({
    columns: { id: 'uuid', ${columns} },
    primaryKey: 'id',
    policies: { select: policy.isAuthenticated() },
  }),
});`;
    writeSchema(schema(`body: 'text', legacy: 'text?'`));
    await cli('generate');
    expect((await cli('push')).code).toBe(0);

    writeSchema(schema(`body: 'text'`));
    const generated = await cli('generate');
    expect(generated.json.destructive[0]).toMatchObject({ kind: 'drop_column' });

    const refused = await cli('push');
    expect(refused.code).toBe(1);
    expect(refused.json.error.code).toBe('DESTRUCTIVE_MIGRATION');
    expect(refused.json.applied).toEqual([]);

    const allowed = await cli('push', '--allow-destructive');
    expect(allowed.code).toBe(0);
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'notes' AND column_name = 'legacy'`);
    expect(rows[0].n).toBe(0);
  }, 60_000);

  it('never seeds on push unless --seed, and seeded users get no known password', async () => {
    writeSchema(`
const schema = defineSchema({
  profiles: table({
    columns: { id: 'uuid', email: 'text' },
    primaryKey: 'id',
    references: { id: 'auth.users.id' },
    policies: { select: policy.isOwner('id') },
  }),
});
export default schema;`);
    writeFileSync(join(cwd, 'accessnexus.seed.ts'), `import schema from './accessnexus.schema';
import { defineSeed } from '${SRC_INDEX}';
export default defineSeed(schema, { profiles: [{ id: '${ALICE}', email: 'alice@example.com' }] });`);
    await cli('generate');

    const plain = await cli('push');
    expect(plain.code).toBe(0);
    expect(plain.json.seed).toBeNull();
    expect((await admin.query(`SELECT count(*)::int AS n FROM auth.users WHERE id = '${ALICE}'`)).rows[0].n).toBe(0);

    const seeded = await cli('push', '--seed');
    expect(seeded.code).toBe(0);
    expect(seeded.json.seed).toMatchObject({ status: 'applied', authUsers: 1 });
    const { rows } = await admin.query(
      `SELECT encrypted_password = crypt('seed-password-123', encrypted_password) AS known FROM auth.users WHERE id = '${ALICE}'`,
    );
    expect(rows[0].known).toBe(false);
  }, 60_000);

  it('enforces the reference schema\'s RLS for real API users', async () => {
    const example = resolve(__dirname, '../../examples/fullstack-saas.schema.ts');
    expect((await cli('generate', '--schema', example)).code).toBe(0);
    const pushed = await cli('push', '--schema', example);
    expect(pushed.code).toBe(0);

    await admin.query(`
      INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
        ('${ALICE}', 'alice@example.com', now()), ('${BOB}', 'bob@example.com', now()),
        ('${CAROL}', 'carol@example.com', now()), ('${DAVE}', 'dave@example.com', NULL);
      INSERT INTO profiles (id, email, name) VALUES
        ('${ALICE}', 'alice@example.com', 'Alice'), ('${BOB}', 'bob@example.com', 'Bob'), ('${CAROL}', 'carol@example.com', 'Carol');
    `);
    const org = (id: string, slug: string, owner: string) =>
      `INSERT INTO organizations (id, name, slug, owner_id, plan) VALUES ('${id}', '${slug}', '${slug}', '${owner}', 'free')`;

    // Creating an org: you must be its owner. The audit trigger writes as definer.
    expect(await rejected(ALICE, org(ORG_B, 'spoof', BOB))).toMatch(/row-level security/);
    await asUser(ALICE, org(ORG_A, 'orga', ALICE));
    await asUser(BOB, org(ORG_B, 'orgb', BOB));
    const audit = await admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'organizations'`);
    expect(audit.rows[0].n).toBe(2);
    expect(await rejected(ALICE, `INSERT INTO audit_log (table_name, operation) VALUES ('x', 'forged')`)).toMatch(/row-level security/);

    // Profiles: a user can only create their own row (no impersonation).
    expect(await rejected(CAROL, `INSERT INTO profiles (id, email, name) VALUES ('${DAVE}', 'dave@example.com', 'Not Dave')`))
      .toMatch(/row-level security/);

    // The creator becomes the first admin through a definer trigger; there is
    // no bootstrap INSERT rule anyone could replay.
    const member = (orgId: string, user: string, role: string) =>
      `INSERT INTO org_members (org_id, user_id, role) VALUES ('${orgId}', '${user}', '${role}')`;
    const roleOf = async (orgId: string, user: string) =>
      (await admin.query(`SELECT role::text FROM org_members WHERE org_id = '${orgId}' AND user_id = '${user}'`)).rows[0]?.role;
    expect(await roleOf(ORG_A, ALICE)).toBe('admin');
    expect(await roleOf(ORG_B, BOB)).toBe('admin');
    expect(await rejected(BOB, member(ORG_A, BOB, 'admin'))).toMatch(/row-level security/);

    // Joining needs consent: nobody inserts memberships directly, not even an
    // admin (otherwise Bob could add Alice to his org and read her profile).
    expect(await rejected(BOB, member(ORG_B, ALICE, 'viewer'))).toMatch(/row-level security/);
    expect(await rejected(ALICE, member(ORG_A, CAROL, 'manager'))).toMatch(/row-level security/);

    // People join by accepting an invitation sent to their confirmed address.
    await asUser(ALICE, `INSERT INTO invitations (org_id, email, role, invited_by, token) VALUES ('${ORG_A}', 'carol@example.com', 'manager', '${ALICE}', 'tok-carol')`);
    await asUser(CAROL, `SELECT accept_invitation('tok-carol')`, { email: 'carol@example.com' });
    expect(await roleOf(ORG_A, CAROL)).toBe('manager');

    // A manager cannot add or promote anyone directly, nor invite managers.
    expect(await rejected(CAROL, member(ORG_A, CAROL, 'admin'))).toMatch(/row-level security/);
    expect(await rejected(CAROL, member(ORG_A, BOB, 'member'))).toMatch(/row-level security/);
    expect(await rejected(CAROL, `INSERT INTO invitations (org_id, email, role, invited_by, token) VALUES ('${ORG_A}', 'bob@example.com', 'manager', '${CAROL}', 'tok-x')`))
      .toMatch(/row-level security/);

    // Manager -> admin escalation through organizations.owner_id is closed:
    // managers cannot update the org, and nobody can rewrite owner_id.
    expect((await asUser(CAROL, `UPDATE organizations SET owner_id = '${CAROL}' WHERE id = '${ORG_A}'`)).rowCount).toBe(0);
    expect(await rejected(ALICE, `UPDATE organizations SET owner_id = '${CAROL}' WHERE id = '${ORG_A}'`)).toMatch(/owner_id cannot be changed/);
    expect(await rejected(ALICE, `UPDATE org_members SET user_id = '${DAVE}' WHERE user_id = '${CAROL}'`)).toMatch(/cannot be changed/);

    // Orgs are visible to their members only (a public directory would expose
    // owner_id and settings); anonymous visitors cannot write either.
    expect((await asUser(null, 'SELECT * FROM organizations')).rowCount).toBe(0);
    expect((await asUser(BOB, 'SELECT id FROM organizations')).rows.map((r) => r.id)).toEqual([ORG_B]);
    expect(await rejected(null, org('cccccccc-0000-0000-0000-000000000003', 'anon', ALICE))).toMatch(/row-level security|permission denied/);

    // Profiles are visible to yourself and your org mates only.
    expect((await asUser(CAROL, 'SELECT id FROM profiles ORDER BY id')).rows.map((r) => r.id)).toEqual([ALICE, CAROL]);
    expect((await asUser(BOB, 'SELECT id FROM profiles ORDER BY id')).rows.map((r) => r.id)).toEqual([BOB]);

    // Global app role (app_metadata.role) gates the audit trail.
    expect((await asUser(ALICE, 'SELECT * FROM audit_log')).rowCount).toBe(0);
    expect((await asUser(ALICE, 'SELECT * FROM audit_log', { appRole: 'admin' })).rowCount).toBeGreaterThan(0);

    // Projects / tasks: creator pinned, rows cannot leave the org.
    const PROJECT = 'a0000000-0000-0000-0000-00000000000a';
    const TASK = 'a1000000-0000-0000-0000-00000000000a';
    expect(await rejected(CAROL, `INSERT INTO projects (id, org_id, name, status, created_by, is_public) VALUES ('${PROJECT}', '${ORG_A}', 'P', 'active', '${ALICE}', false)`)).toMatch(/row-level security/);
    await asUser(CAROL, `INSERT INTO projects (id, org_id, name, status, created_by, is_public) VALUES ('${PROJECT}', '${ORG_A}', 'P', 'active', '${CAROL}', false)`);
    const task = (reporter: string) => `INSERT INTO tasks (id, org_id, project_id, title, status, priority, assignee_id, reporter_id, position)
      VALUES ('${TASK}', '${ORG_A}', '${PROJECT}', 'T', 'todo', 'low', '${CAROL}', '${reporter}', 1)`;
    expect(await rejected(CAROL, task(ALICE))).toMatch(/row-level security/);
    await asUser(CAROL, task(CAROL));
    expect(await rejected(CAROL, `UPDATE tasks SET org_id = '${ORG_B}', title = 'moved'`)).toMatch(/row-level security|cannot be changed/);
    expect(await rejected(CAROL, `UPDATE projects SET org_id = '${ORG_B}'`)).toMatch(/row-level security|cannot be changed/);

    // Soft delete only through DELETE: a manager (projects.delete is admin-only)
    // cannot soft-delete with UPDATE, nor DELETE.
    expect(await rejected(CAROL, `UPDATE projects SET deleted_at = now() WHERE id = '${PROJECT}'`)).toMatch(/can only be set by DELETE/);
    expect((await asUser(CAROL, `DELETE FROM projects WHERE id = '${PROJECT}'`)).rowCount).toBe(0);
    expect((await admin.query(`SELECT deleted_at FROM projects WHERE id = '${PROJECT}'`)).rows[0].deleted_at).toBeNull();

    // A task cannot point at another org's project (FKs only check existence).
    const PROJECT_B = 'b0000000-0000-0000-0000-00000000000b';
    await asUser(BOB, `INSERT INTO projects (id, org_id, name, status, created_by, is_public) VALUES ('${PROJECT_B}', '${ORG_B}', 'PB', 'active', '${BOB}', false)`);
    expect(await rejected(CAROL, `INSERT INTO tasks (org_id, project_id, title, status, priority, reporter_id, position)
      VALUES ('${ORG_A}', '${PROJECT_B}', 'X', 'todo', 'low', '${CAROL}', 2)`)).toMatch(/does not belong to org/);

    // Comments: authors cannot re-attribute their comment; edits must set edited = true.
    const COMMENT = 'a2000000-0000-0000-0000-00000000000a';
    await asUser(CAROL, `INSERT INTO comments (id, org_id, task_id, author_id, body, edited) VALUES ('${COMMENT}', '${ORG_A}', '${TASK}', '${CAROL}', 'hi', false)`);
    expect(await rejected(CAROL, `UPDATE comments SET author_id = '${ALICE}', edited = true WHERE id = '${COMMENT}'`)).toMatch(/row-level security/);
    expect(await rejected(CAROL, `UPDATE comments SET body = 'x' WHERE id = '${COMMENT}'`)).toMatch(/row-level security/);
    expect((await asUser(CAROL, `UPDATE comments SET body = 'edited', edited = true WHERE id = '${COMMENT}'`)).rowCount).toBe(1);

    // Soft delete by an org admin (allowed by the DELETE policy) sets deleted_at.
    await asUser(ALICE, `DELETE FROM comments WHERE id = '${COMMENT}'`);
    const soft = await admin.query(`SELECT deleted_at IS NOT NULL AS deleted FROM comments WHERE id = '${COMMENT}'`);
    expect(soft.rows[0].deleted).toBe(true);

    // Invitations: only the invited email can accept; the enum cast works.
    await asUser(ALICE, `INSERT INTO invitations (org_id, email, role, invited_by, token) VALUES ('${ORG_A}', 'bob@example.com', 'member', '${ALICE}', 'tok-bob')`);
    expect(await rejected(CAROL, `SELECT accept_invitation('tok-bob')`, { email: 'carol@example.com' })).toMatch(/another email/);
    await asUser(BOB, `SELECT accept_invitation('tok-bob')`, { email: 'bob@example.com' });
    expect(await roleOf(ORG_A, BOB)).toBe('member');
    // An unconfirmed address cannot accept (someone may have signed up with it).
    await asUser(ALICE, `INSERT INTO invitations (org_id, email, role, invited_by, token) VALUES ('${ORG_A}', 'dave@example.com', 'member', '${ALICE}', 'tok-dave')`);
    expect(await rejected(DAVE, `SELECT accept_invitation('tok-dave')`, { email: 'dave@example.com' })).toMatch(/Confirm your email/);
    expect(await rejected(null, `SELECT accept_invitation('tok-bob')`)).toMatch(/permission denied/);

    // Assignees may only change status/position; reporter is frozen for everyone.
    const TASK_BOB = 'a1000000-0000-0000-0000-00000000000b';
    await asUser(CAROL, `INSERT INTO tasks (id, org_id, project_id, title, status, priority, assignee_id, reporter_id, position)
      VALUES ('${TASK_BOB}', '${ORG_A}', '${PROJECT}', 'For Bob', 'todo', 'low', '${BOB}', '${CAROL}', 3)`);
    expect((await asUser(BOB, `UPDATE tasks SET status = 'in_progress' WHERE id = '${TASK_BOB}'`)).rowCount).toBe(1);
    expect(await rejected(BOB, `UPDATE tasks SET title = 'mine now' WHERE id = '${TASK_BOB}'`)).toMatch(/only status, position can be changed/);
    expect(await rejected(BOB, `UPDATE tasks SET assignee_id = '${CAROL}' WHERE id = '${TASK_BOB}'`)).toMatch(/only status, position can be changed/);
    expect(await rejected(CAROL, `UPDATE tasks SET reporter_id = '${ALICE}' WHERE id = '${TASK_BOB}'`)).toMatch(/reporter_id, org_id cannot be changed/);
    expect((await asUser(CAROL, `UPDATE tasks SET title = 'Renamed' WHERE id = '${TASK_BOB}'`)).rowCount).toBe(1);

    // A removed admin cannot rejoin by themselves.
    await asUser(ALICE, `UPDATE org_members SET role = 'admin' WHERE org_id = '${ORG_A}' AND user_id = '${BOB}'`);
    await asUser(BOB, `DELETE FROM org_members WHERE org_id = '${ORG_A}' AND user_id = '${ALICE}'`);
    expect(await rejected(ALICE, member(ORG_A, ALICE, 'admin'))).toMatch(/row-level security/);

    // Membership helpers are not callable by anon through /rest/v1/rpc.
    expect(await rejected(null, `SELECT accessnexus_tasks_belongs_to_1_fn('${ORG_A}')`)).toMatch(/permission denied/);
  }, 90_000);

  it('llms.txt recipes hold against real API users', async () => {
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', 'a@x.io'), ('${BOB}', 'b@x.io'), ('${CAROL}', 'c@x.io')`);

    // Multi-tenant: the creator becomes owner via a definer trigger; once removed, cannot rejoin.
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), llmsRecipe('team_members: table'));
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const TEAM = 'cccccccc-0000-0000-0000-00000000000c';
    await asUser(ALICE, `INSERT INTO teams (id, name, created_by) VALUES ('${TEAM}', 'T', '${ALICE}')`);
    expect((await admin.query(`SELECT role::text FROM team_members WHERE team_id = '${TEAM}' AND user_id = '${ALICE}'`)).rows[0]?.role).toBe('owner');
    expect(await rejected(BOB, `INSERT INTO team_members (team_id, user_id, role) VALUES ('${TEAM}', '${BOB}', 'owner')`)).toMatch(/row-level security/);
    await asUser(ALICE, `INSERT INTO team_members (team_id, user_id, role) VALUES ('${TEAM}', '${BOB}', 'owner')`);
    expect((await asUser(BOB, `DELETE FROM team_members WHERE team_id = '${TEAM}' AND user_id = '${ALICE}'`)).rowCount).toBe(1);
    expect(await rejected(ALICE, `INSERT INTO team_members (team_id, user_id, role) VALUES ('${TEAM}', '${ALICE}', 'owner')`)).toMatch(/row-level security/);
    expect(await rejected(BOB, `UPDATE team_members SET user_id = '${CAROL}' WHERE user_id = '${BOB}'`)).toMatch(/cannot be changed/);
    // Deleting the team cascades to its memberships and projects.
    await asUser(BOB, `INSERT INTO projects (team_id, created_by, name) VALUES ('${TEAM}', '${BOB}', 'P')`);
    expect((await asUser(BOB, `DELETE FROM teams WHERE id = '${TEAM}'`)).rowCount).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM projects`)).rows[0].n).toBe(0);

    // Public read: anon reads published rows only and cannot write.
    await resetDatabase();
    rmSync(join(cwd, 'generated'), { recursive: true, force: true });
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', 'a@x.io'), ('${BOB}', 'b@x.io')`);
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), llmsRecipe('articles: table'));
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    await asUser(ALICE, `INSERT INTO articles (author_id, title, published) VALUES ('${ALICE}', 'pub', true), ('${ALICE}', 'draft', false)`);
    expect((await asUser(null, 'SELECT title FROM articles')).rows.map((r) => r.title)).toEqual(['pub']);
    expect(await rejected(null, `INSERT INTO articles (author_id, title, published) VALUES ('${ALICE}', 'x', true)`)).toMatch(/row-level security|permission denied/);

    // Column-scoped update: the assignee changes only status.
    await resetDatabase();
    rmSync(join(cwd, 'generated'), { recursive: true, force: true });
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', 'a@x.io'), ('${BOB}', 'b@x.io')`);
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), llmsRecipe('tickets: table'));
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const TICKET = 'dddddddd-0000-0000-0000-00000000000d';
    await asUser(ALICE, `INSERT INTO tickets (id, org_id, reporter_id, assignee_id, title) VALUES ('${TICKET}', '${TEAM}', '${ALICE}', '${BOB}', 'T')`);
    expect((await asUser(BOB, `UPDATE tickets SET status = 'doing' WHERE id = '${TICKET}'`)).rowCount).toBe(1);
    expect(await rejected(BOB, `UPDATE tickets SET title = 'mine' WHERE id = '${TICKET}'`)).toMatch(/only status can be changed/);
    expect(await rejected(ALICE, `UPDATE tickets SET reporter_id = '${BOB}' WHERE id = '${TICKET}'`)).toMatch(/cannot be changed/);
    expect((await asUser(ALICE, `UPDATE tickets SET title = 'Renamed' WHERE id = '${TICKET}'`)).rowCount).toBe(1);
  }, 90_000);

  it('fails closed: no policies = deny-all; soft-deleted and cross-tenant rows stay out', async () => {
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', 'a@x.io'), ('${BOB}', 'b@x.io')`);

    // A table without policies gets RLS (deny-all); only enableRLS: false leaves it open.
    writeSchema(`export default defineSchema({
      secrets: table({ columns: { id: 'uuid', value: 'text' }, primaryKey: 'id' }),
      open_board: table({ columns: { id: 'uuid', note: 'text' }, primaryKey: 'id', enableRLS: false }),
    });`);
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    await admin.query(`INSERT INTO secrets (value) VALUES ('api-key'); INSERT INTO open_board (note) VALUES ('hi')`);
    expect((await asUser(null, 'SELECT * FROM secrets')).rowCount).toBe(0);
    expect((await asUser(ALICE, 'SELECT * FROM secrets')).rowCount).toBe(0);
    expect(await rejected(ALICE, `INSERT INTO secrets (value) VALUES ('x')`)).toMatch(/row-level security/);
    expect((await asUser(null, 'SELECT * FROM open_board')).rowCount).toBe(1);

    // llms.txt manual example: a soft-deleted published post is not publicly readable.
    await resetDatabase();
    rmSync(join(cwd, 'generated'), { recursive: true, force: true });
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', 'a@x.io'), ('${BOB}', 'b@x.io')`);
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), llmsRecipe('posts: table'));
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    await asUser(ALICE, `INSERT INTO profiles (id, name) VALUES ('${ALICE}', 'Alice')`);
    await asUser(ALICE, `INSERT INTO posts (author_id, title, status) VALUES ('${ALICE}', 'gone', 'published'), ('${ALICE}', 'live', 'published')`);
    await asUser(ALICE, `DELETE FROM posts WHERE title = 'gone'`);
    expect((await admin.query(`SELECT deleted_at FROM posts WHERE title = 'gone'`)).rows[0].deleted_at).not.toBeNull();
    expect((await asUser(null, 'SELECT title FROM posts')).rows.map((r) => r.title)).toEqual(['live']);
    expect((await asUser(BOB, 'SELECT title FROM posts')).rows.map((r) => r.title)).toEqual(['live']);

    // llms.txt "Child of a tenant resource": a task cannot point at another org's project.
    await resetDatabase();
    rmSync(join(cwd, 'generated'), { recursive: true, force: true });
    await admin.query(`INSERT INTO auth.users (id, email) VALUES ('${ALICE}', 'a@x.io'), ('${BOB}', 'b@x.io')`);
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), llmsRecipe('same_org_project'));
    expect((await cli('validate')).json.summary).toEqual({ errors: 0, warnings: 0 });
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const PA = 'aaaaaaaa-1111-0000-0000-000000000001';
    const PB = 'bbbbbbbb-1111-0000-0000-000000000002';
    await admin.query(`
      INSERT INTO orgs (id, name) VALUES ('${ORG_A}', 'A'), ('${ORG_B}', 'B');
      INSERT INTO org_members (org_id, user_id, role) VALUES ('${ORG_A}', '${ALICE}', 'admin'), ('${ORG_B}', '${BOB}', 'admin');
      INSERT INTO projects (id, org_id, name) VALUES ('${PA}', '${ORG_A}', 'PA'), ('${PB}', '${ORG_B}', 'PB');
    `);
    expect(await rejected(ALICE, `INSERT INTO tasks (org_id, project_id, title) VALUES ('${ORG_A}', '${PB}', 'sneaky')`)).toMatch(/not found in org/);
    await asUser(ALICE, `INSERT INTO tasks (org_id, project_id, title) VALUES ('${ORG_A}', '${PA}', 'ok')`);
    expect(await rejected(ALICE, `UPDATE tasks SET project_id = '${PB}'`)).toMatch(/not found in org|cannot be changed/);
    expect((await asUser(BOB, 'SELECT * FROM tasks')).rowCount).toBe(0);
  }, 90_000);

  it('init --db-url imports policies without granting more than the database did', async () => {
    await admin.query(`
      CREATE TABLE public.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), value text NOT NULL, tenant text NOT NULL);
      ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "service only" ON public.secrets FOR ALL TO service_role USING (true) WITH CHECK (true);
      CREATE TABLE public.docs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant text NOT NULL, body text);
      ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "read all" ON public.docs FOR SELECT USING (true);
      CREATE POLICY tenant_ok ON public.docs AS RESTRICTIVE FOR ALL USING (tenant = 'a');
      GRANT ALL ON public.secrets, public.docs TO anon, authenticated;
      INSERT INTO public.secrets (value, tenant) VALUES ('api-key-123', 'a');
      INSERT INTO public.docs (tenant, body) VALUES ('a', 'visible'), ('b', 'hidden');
    `);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    expect((await cli('init', '--yes', '--no-agents', '--db-url', DB_URL!)).code).toBe(0);
    const schema = readFileSync(join(cwd, 'accessnexus.schema.ts'), 'utf-8');
    expect(schema).toContain('"service only" (PERMISSIVE, ALL, TO service_role): skipped');
    expect(schema).toContain('policy.all([');
    writeFileSync(join(cwd, 'accessnexus.schema.ts'), schema.replaceAll("from 'accessnexus'", `from '${SRC_INDEX}'`));

    // Judge the imported rules alone: push refuses while the original policies are
    // there, and --replace-foreign-policies drops them in the push transaction.
    expect((await cli('generate')).code).toBe(0);
    const refused = await cli('push');
    expect(refused.json.error.code).toBe('FOREIGN_POLICIES');
    expect(refused.json.foreignPolicies.map((p: any) => p.policy).sort()).toEqual(['read all', 'service only', 'tenant_ok']);
    const pushed = await cli('push', '--replace-foreign-policies');
    expect(pushed.json.error ?? null).toBeNull();
    expect((await asUser(null, 'SELECT * FROM secrets')).rowCount).toBe(0);
    expect((await asUser(ALICE, 'DELETE FROM secrets')).rowCount).toBe(0);
    expect((await admin.query('SELECT count(*)::int AS n FROM secrets')).rows[0].n).toBe(1);
    // The RESTRICTIVE tenant filter still applies on top of "read all".
    expect((await asUser(null, 'SELECT body FROM docs')).rows.map((r) => r.body)).toEqual(['visible']);
  }, 90_000);
  const notesSchema = (extra = '') => `
export default defineSchema({
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isOwner('owner_id'), insert: policy.isOwner('owner_id'), update: policy.isOwner('owner_id'), delete: policy.isOwner('owner_id') },
  }),${extra}
});`;

  async function policyNames(table: string): Promise<string[]> {
    const { rows } = await admin.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [table]);
    return rows.map((r: any) => r.policyname);
  }

  it('refuses foreign policies on managed tables, and replaces them only with --replace-foreign-policies', async () => {
    // A pre-existing project: the table and a permissive policy AccessNexus did not write.
    await admin.query(`
      CREATE TABLE public.notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid, body text NOT NULL);
      ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "anyone can read" ON public.notes FOR SELECT USING (true);
      GRANT ALL ON public.notes TO anon, authenticated;
      INSERT INTO public.notes (owner_id, body) VALUES ('${ALICE}', 'alice note');
    `);
    writeSchema(notesSchema());
    expect((await cli('generate')).code).toBe(0);

    // Dry run reports them without touching the database.
    const dry = await cli('push', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.json.wouldRefuse).toBe(true);
    expect(dry.json.foreignPolicies).toEqual([
      { schema: 'public', table: 'notes', policy: 'anyone can read', command: 'SELECT', permissive: true },
    ]);

    const refused = await cli('push');
    expect(refused.code).toBe(1);
    expect(refused.json.error.code).toBe('FOREIGN_POLICIES');
    expect(refused.json.error.message).toContain('public.notes: "anyone can read"');
    expect(refused.json.error.hint).toContain('--replace-foreign-policies');
    expect(refused.json.foreignPolicies).toHaveLength(1);
    expect(refused.json.applied).toEqual([]);
    // Database unchanged: no bookkeeping table, only the original policy.
    expect((await admin.query(`SELECT to_regclass('public.accessnexus_migrations') IS NULL AS absent`)).rows[0].absent).toBe(true);
    expect(await policyNames('notes')).toEqual(['anyone can read']);

    const replaced = await cli('push', '--replace-foreign-policies');
    expect(replaced.json.error ?? null).toBeNull();
    expect(replaced.code).toBe(0);
    expect(replaced.json.droppedPolicies.map((p: any) => p.policy)).toEqual(['anyone can read']);
    expect(await policyNames('notes')).toEqual([
      'accessnexus_notes_delete', 'accessnexus_notes_insert', 'accessnexus_notes_select', 'accessnexus_notes_update',
    ]);
    // Access now matches the schema: owner only.
    expect((await asUser(null, 'SELECT * FROM notes')).rowCount).toBe(0);
    expect((await asUser(BOB, 'SELECT * FROM notes')).rowCount).toBe(0);
    expect((await asUser(ALICE, 'SELECT * FROM notes')).rowCount).toBe(1);

    // A later push with nothing foreign left needs no flag.
    expect((await cli('push')).code).toBe(0);
  }, 60_000);

  it('push is atomic: a failing RPC file rolls back migrations, policies and bookkeeping', async () => {
    writeSchema(notesSchema());
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    const before = (await admin.query(`SELECT category, filename, checksum FROM accessnexus_migrations ORDER BY id`)).rows;
    const policiesBefore = await policyNames('notes');

    // New table + changed policies + an RPC Postgres rejects (unknown table).
    writeSchema(`
export default defineSchema({
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isAuthenticated(), insert: policy.isOwner('owner_id') },
  }),
  tags: table({
    columns: { id: 'uuid', name: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isAuthenticated() },
  }),
}, {
  rpcs: {
    broken: rpc({ returns: 'int', language: 'sql', body: 'SELECT count(*)::int FROM table_that_does_not_exist;' }),
  },
});`);
    expect((await cli('generate')).code).toBe(0);
    const failed = await cli('push');
    expect(failed.code).toBe(1);
    expect(failed.json.error.code).toBe('PUSH_FAILED');
    expect(failed.json.failed).toMatch(/rpcs/);
    expect(failed.json.applied).toEqual([]);
    expect(failed.json.rolledBack.length).toBeGreaterThan(0);
    expect(failed.json.error.hint).toContain('rolled back');

    // Nothing from the failed push remains.
    expect((await admin.query(`SELECT category, filename, checksum FROM accessnexus_migrations ORDER BY id`)).rows).toEqual(before);
    expect(await policyNames('notes')).toEqual(policiesBefore);
    expect((await admin.query(`SELECT to_regclass('public.tags') IS NULL AS absent`)).rows[0].absent).toBe(true);
    // The advisory lock was released.
    const lock = await admin.query(`SELECT pg_try_advisory_lock(hashtext('accessnexus_push_lock')) AS ok`);
    expect(lock.rows[0].ok).toBe(true);
    await admin.query(`SELECT pg_advisory_unlock(hashtext('accessnexus_push_lock'))`);
  }, 60_000);

  it('uuidGeneration v7 creates a real, time-ordered UUIDv7 helper that anon cannot call', async () => {
    writeFileSync(join(cwd, 'accessnexus.config.ts'), `import { defineConfig } from '${SRC_INDEX}';\nexport default defineConfig({ adapterOptions: { uuidGeneration: 'v7' } });\n`);
    writeSchema(notesSchema());
    expect((await cli('generate')).code).toBe(0);
    const pushed = await cli('push', '--db-url', DB_URL!);
    expect(pushed.json.error ?? null).toBeNull();

    // No v4 impostor under another name.
    expect((await admin.query(`SELECT to_regprocedure('public.uuid_generate_v7()') IS NULL AS absent`)).rows[0].absent).toBe(true);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { rows } = await admin.query(`INSERT INTO notes (owner_id, body) VALUES ('${ALICE}', 'n${i}') RETURNING id::text`);
      ids.push(rows[0].id);
      await admin.query('SELECT pg_sleep(0.003)');
    }
    for (const id of ids) {
      expect(id[14]).toBe('7'); // version nibble
      expect('89ab').toContain(id[19]); // RFC 9562 variant
    }
    expect([...ids].sort()).toEqual(ids);
    // The first 48 bits are the current Unix time in milliseconds.
    const ms = parseInt(ids[0].replaceAll('-', '').slice(0, 12), 16);
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);

    // A signed-in user's insert uses the default; anon cannot call it as an RPC.
    expect((await asUser(ALICE, `INSERT INTO notes (owner_id, body) VALUES ('${ALICE}', 'api')`)).rowCount).toBe(1);
    expect(await rejected(null, 'SELECT public.accessnexus_uuidv7()')).toMatch(/permission denied/);
  }, 60_000);

});
