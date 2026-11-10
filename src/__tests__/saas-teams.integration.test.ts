// examples/saas-teams pushed to a real Supabase Postgres, checked as real API users
// with the accessnexus/testing kit. Ported from the field report's RLS suite.
// Skipped unless ACCESSNEXUS_TEST_DB_URL is set (see push.integration.test.ts, or
// `npx accessnexus test-db up`). The tests DROP every table in the public schema.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';
import { affectedRows, asAnon, asUser, expectDenied, sqlState, type TestClient, type TestUser } from '../testing/index.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SCHEMA = resolve(__dirname, '../../examples/saas-teams/accessnexus.schema.ts');

const u = (n: number, name: string, confirmed = true) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  email: `${name}@rls.test`,
  confirmed,
});
const ALICE = u(1, 'alice'); // owner of A
const BOB = u(2, 'bob'); // admin of A
const CAROL = u(3, 'carol'); // member of A
const DAVE = u(4, 'dave'); // viewer of A
const ERIN = u(5, 'erin'); // owner of B (the outsider)
const FRANK = u(6, 'frank'); // invited to A, confirmed
const GINA = u(7, 'gina', false); // invited to A, not confirmed
const USERS = [ALICE, BOB, CAROL, DAVE, ERIN, FRANK, GINA];

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const PROJ_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const PROJ_B = 'bbbbbbbb-1111-4000-8000-000000000002';
const TASK_CAROL = 'aaaaaaaa-2222-4000-8000-000000000001';
const TASK_BOB = 'aaaaaaaa-2222-4000-8000-000000000002';
const INV_FRANK = 'aaaaaaaa-3333-4000-8000-000000000001';
const INV_GINA = 'aaaaaaaa-3333-4000-8000-000000000002';

const RLS = '42501';
const FK = '23503';
const CHECK = '23514';

let pool: any;
let cwd: string;
let previousCwd: string;
const admin = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const asU = <T>(user: (typeof USERS)[number], fn: (db: TestClient) => Promise<T>) =>
  asUser(pool, { id: user.id, email: user.email } satisfies TestUser, fn);
const ids = async (db: TestClient, sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows.map((row) => Object.values(row)[0]).sort();

async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await runCli([...argv, '--json']);
  vi.restoreAllMocks();
  return { code, json: JSON.parse(stdout) };
}

describe.skipIf(!DB_URL)('examples/saas-teams against real API users', () => {
  beforeAll(async () => {
    let pg: any = await import('pg');
    pg = pg.default ?? pg;
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
    const lock = await pool.connect();
    await lock.query('SELECT pg_advisory_lock(727274)');
    // Keep the lock for the whole file (released when the pool ends).
    (pool as any).__lock = lock;
    await admin(`
      DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
        END LOOP;
        FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
          EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
        END LOOP;
      END $$;`);
    await admin('DELETE FROM auth.users WHERE id = ANY($1)', [USERS.map((x) => x.id)]);

    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-saas-'));
    process.chdir(cwd);
    const gen = await cli('generate', '--schema', SCHEMA, '--output', 'out', '--sql-only');
    expect(gen.code).toBe(0);
    const push = await cli('push', '--schema', SCHEMA, '--output', 'out', '--url', DB_URL!);
    if (push.code !== 0) throw new Error(JSON.stringify(push.json.error));

    for (const user of USERS) {
      await admin(
        `INSERT INTO auth.users (id, email, aud, role, email_confirmed_at) VALUES ($1, $2, 'authenticated', 'authenticated', $3)`,
        [user.id, user.email, user.confirmed ? new Date() : null],
      );
    }
    await admin(`INSERT INTO public.orgs (id, name, created_by) VALUES ($1, 'Org A', $2), ($3, 'Org B', $4)`, [ORG_A, ALICE.id, ORG_B, ERIN.id]);
    await admin(`INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [ORG_A, BOB.id, CAROL.id, DAVE.id]);
    await admin(`INSERT INTO public.projects (id, org_id, name, created_by) VALUES ($1, $2, 'Site', $3), ($4, $5, 'Secret', $6)`,
      [PROJ_A, ORG_A, CAROL.id, PROJ_B, ORG_B, ERIN.id]);
    await admin(`INSERT INTO public.tasks (id, org_id, user_id, title) VALUES ($1, $2, $3, 'Carol task'), ($4, $2, $5, 'Bob task')`,
      [TASK_CAROL, ORG_A, CAROL.id, TASK_BOB, BOB.id]);
    await admin(`INSERT INTO public.invitations (id, org_id, email, role, invited_by) VALUES ($1, $2, $3, 'member', $4), ($5, $2, $6, 'viewer', $4)`,
      [INV_FRANK, ORG_A, FRANK.email, ALICE.id, INV_GINA, GINA.email]);
  }, 180_000);

  afterAll(async () => {
    if (previousCwd) process.chdir(previousCwd);
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    (pool as any)?.__lock?.release();
    await pool?.end();
  });

  it('sign-up creates the profile (trigger.onAuthUserCreated)', async () => {
    const { rows } = await admin('SELECT id, display_name FROM public.profiles WHERE id = ANY($1) ORDER BY id', [USERS.map((x) => x.id)]);
    expect(rows.map((r: any) => r.display_name)).toEqual(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina']);
  });

  describe('isolation and same-tenant guards', () => {
    it('members of A see A; the outsider and anonymous visitors see nothing of it', async () => {
      await asU(DAVE, async (db) => expect(await ids(db, 'SELECT id FROM tasks')).toEqual([TASK_CAROL, TASK_BOB].sort()));
      await asU(ERIN, async (db) => expect(await ids(db, 'SELECT id FROM tasks WHERE org_id = $1', [ORG_A])).toEqual([]));
      await asAnon(pool, async (db) => expect(await ids(db, 'SELECT id FROM orgs')).toEqual([]));
    });

    it('a task cannot point at another org’s project (trigger.sameTenant)', async () => {
      await asU(CAROL, async (db) => {
        expect(await sqlState(db, 'UPDATE tasks SET project_id = $1 WHERE id = $2', [PROJ_B, TASK_CAROL])).toBe(FK);
        expect(await sqlState(db, 'UPDATE tasks SET project_id = $1 WHERE id = $2', [PROJ_A, TASK_CAROL])).toBe('ok');
      });
    });

    it('only members of the org can be assigned (trigger.memberOfTenant)', async () => {
      await asU(CAROL, async (db) => {
        expect(await sqlState(db, 'UPDATE tasks SET assignee_id = $1 WHERE id = $2', [ERIN.id, TASK_CAROL])).toBe(FK);
        expect(await sqlState(db, 'UPDATE tasks SET assignee_id = $1 WHERE id = $2', [DAVE.id, TASK_CAROL])).toBe('ok');
        expect(await sqlState(db, 'UPDATE tasks SET assignee_id = NULL WHERE id = $1', [TASK_CAROL])).toBe('ok');
      });
    });

    it('a task never moves to another org; the locked column is named in a stable hint', async () => {
      await asU(CAROL, async (db) => {
        await db.query('SAVEPOINT s');
        const err = await db.query('UPDATE tasks SET org_id = $1 WHERE id = $2', [ORG_B, TASK_CAROL]).then(() => null, (e: any) => e);
        await db.query('ROLLBACK TO SAVEPOINT s');
        expect(err?.code).toBe(RLS);
        expect(err?.hint).toBe('accessnexus:locked_column:tasks.org_id');
      });
    });
  });

  describe('memberships (trigger.keepAtLeastOne)', () => {
    it('co-members see each other; nobody adds members directly', async () => {
      await asU(DAVE, async (db) => expect((await ids(db, 'SELECT user_id FROM org_members WHERE org_id = $1', [ORG_A])).length).toBe(4));
      await asU(ALICE, async (db) => expect(await sqlState(db, `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [ORG_A, FRANK.id])).toBe(RLS));
    });

    it('the last owner cannot step down or leave; with a second owner they can', async () => {
      await asU(ALICE, async (db) => {
        expect(await sqlState(db, `UPDATE org_members SET role = 'admin' WHERE user_id = $1 AND org_id = $2`, [ALICE.id, ORG_A])).toBe(CHECK);
        expect(await sqlState(db, 'DELETE FROM org_members WHERE user_id = $1 AND org_id = $2', [ALICE.id, ORG_A])).toBe(CHECK);
        expect(await affectedRows(db, `UPDATE org_members SET role = 'owner' WHERE user_id = $1`, [BOB.id])).toBe(1);
        expect(await affectedRows(db, 'DELETE FROM org_members WHERE user_id = $1 AND org_id = $2', [ALICE.id, ORG_A])).toBe(1);
      });
    });

    it('the org can still be deleted (cascade passes the guard)', async () => {
      await asU(ERIN, async (db) => expect(await affectedRows(db, 'DELETE FROM orgs WHERE id = $1', [ORG_B])).toBe(1));
    });

    it('admins move people between member and viewer, never above', async () => {
      await asU(BOB, async (db) => {
        expect(await affectedRows(db, `UPDATE org_members SET role = 'viewer' WHERE user_id = $1`, [CAROL.id])).toBe(1);
        // Denied as an error (WITH CHECK) or as 0 rows (USING): expectDenied covers both.
        expect((await expectDenied(db, `UPDATE org_members SET role = 'admin' WHERE user_id = $1`, [DAVE.id])).denied).toBe(true);
        expect(await expectDenied(db, `UPDATE org_members SET role = 'owner' WHERE user_id = $1`, [BOB.id])).toEqual({ denied: true, by: 'no_rows' });
      });
    });
  });

  describe('invitations (tenantInvitations)', () => {
    const invite = (role: string, email: string, by: string) =>
      ['INSERT INTO invitations (org_id, email, role, invited_by) VALUES ($1, $2, $3, $4)', [ORG_A, email, role, by]] as const;

    it('owners invite any role; admins only member/viewer; members and viewers none', async () => {
      await asU(ALICE, async (db) => expect(await sqlState(db, ...invite('admin', 'new@rls.test', ALICE.id))).toBe('ok'));
      await asU(BOB, async (db) => {
        expect(await sqlState(db, ...invite('member', 'm@rls.test', BOB.id))).toBe('ok');
        expect(await sqlState(db, ...invite('admin', 'a@rls.test', BOB.id))).toBe(RLS);
      });
      await asU(CAROL, async (db) => expect(await sqlState(db, ...invite('viewer', 'v@rls.test', CAROL.id))).toBe(RLS));
      await asU(ALICE, async (db) => expect(await sqlState(db, ...invite('owner', 'o@rls.test', ALICE.id))).toBe(RLS));
    });

    it('nobody invites in someone else’s name, nor into an org they are not in', async () => {
      await asU(BOB, async (db) => expect(await sqlState(db, ...invite('member', 'x@rls.test', ALICE.id))).toBe(RLS));
      await asU(ERIN, async (db) => expect(await sqlState(db, ...invite('member', 'x@rls.test', ERIN.id))).toBe(RLS));
    });

    it('invitees see their own invitation and the org name through my_invitations', async () => {
      await asU(FRANK, async (db) => {
        expect(await ids(db, 'SELECT id FROM invitations')).toEqual([INV_FRANK]);
        const { rows } = await db.query('SELECT tenant_name, role FROM my_invitations()');
        expect(rows).toEqual([{ tenant_name: 'Org A', role: 'member' }]);
      });
      await asU(CAROL, async (db) => expect((await db.query('SELECT * FROM my_invitations()')).rows).toEqual([]));
    });

    it('accepting joins with the invited role and consumes the invitation', async () => {
      await asU(FRANK, async (db) => {
        const { rows } = await db.query('SELECT accept_invitation($1) AS org', [INV_FRANK]);
        expect(rows[0].org).toBe(ORG_A);
        expect(await ids(db, 'SELECT role FROM org_members WHERE user_id = $1', [FRANK.id])).toEqual(['member']);
        expect(await ids(db, 'SELECT id FROM invitations')).toEqual([]);
      });
    });

    it('nobody accepts another e-mail’s invite, with an unconfirmed e-mail, or anonymously', async () => {
      await asU(ERIN, async (db) => expect(await sqlState(db, 'SELECT accept_invitation($1)', [INV_FRANK])).toBe('P0002'));
      await asU(GINA, async (db) => expect(await sqlState(db, 'SELECT accept_invitation($1)', [INV_GINA])).toBe(RLS));
      await asAnon(pool, async (db) => expect(await sqlState(db, 'SELECT accept_invitation($1)', [INV_FRANK])).toBe(RLS));
    });

    it('the invitee declines, admins revoke, outsiders do neither; nobody edits', async () => {
      await asU(FRANK, async (db) => expect(await affectedRows(db, 'DELETE FROM invitations WHERE id = $1', [INV_FRANK])).toBe(1));
      await asU(BOB, async (db) => expect(await affectedRows(db, 'DELETE FROM invitations WHERE id = $1', [INV_GINA])).toBe(1));
      await asU(ERIN, async (db) => expect(await expectDenied(db, 'DELETE FROM invitations WHERE id = $1', [INV_GINA])).toEqual({ denied: true, by: 'no_rows' }));
      await asU(FRANK, async (db) => expect((await expectDenied(db, "UPDATE invitations SET role = 'admin' WHERE id = $1", [INV_FRANK])).denied).toBe(true));
    });
  });

  describe('profiles (policy.sharesTenant)', () => {
    it('visible to yourself and to people who share an org, nobody else', async () => {
      await asU(CAROL, async (db) => expect(await ids(db, 'SELECT id FROM profiles')).toEqual([ALICE.id, BOB.id, CAROL.id, DAVE.id].sort()));
      await asU(FRANK, async (db) => expect(await ids(db, 'SELECT id FROM profiles')).toEqual([FRANK.id]));
    });

    it('the membership helper is STABLE and SECURITY DEFINER', async () => {
      const { rows } = await admin(`SELECT provolatile, prosecdef FROM pg_proc WHERE proname LIKE 'accessnexus_profiles_shares_tenant_%_fn'`);
      expect(rows).toEqual([{ provolatile: 's', prosecdef: true }]);
    });

    it('org_people lists members with names and the shared enum role', async () => {
      await asU(DAVE, async (db) => {
        const { rows } = await db.query('SELECT display_name, role FROM org_people($1)', [ORG_A]);
        expect(rows.map((r: any) => `${r.display_name}:${r.role}`)).toEqual(['alice:owner', 'bob:admin', 'carol:member', 'dave:viewer']);
      });
      await asU(ERIN, async (db) => expect((await db.query('SELECT * FROM org_people($1)', [ORG_A])).rows).toEqual([]));
      const { rows } = await admin(`SELECT count(*)::int AS n FROM pg_type WHERE typname IN ('member_role', 'org_members_role_enum', 'invitations_role_enum')`);
      expect(rows[0].n).toBe(1); // one shared type, no per-column copies
    });
  });

  describe('tasks (definePermissions { all: [...] })', () => {
    it('members delete their own tasks; owners and admins delete any; viewers none', async () => {
      await asU(CAROL, async (db) => {
        expect(await affectedRows(db, 'DELETE FROM tasks WHERE id = $1', [TASK_CAROL])).toBe(1);
        expect(await expectDenied(db, 'DELETE FROM tasks WHERE id = $1', [TASK_BOB])).toEqual({ denied: true, by: 'no_rows' });
      });
      await asU(BOB, async (db) => expect(await affectedRows(db, 'DELETE FROM tasks WHERE id = $1', [TASK_CAROL])).toBe(1));
      await asU(DAVE, async (db) => expect(await expectDenied(db, 'DELETE FROM tasks WHERE id = $1', [TASK_CAROL])).toEqual({ denied: true, by: 'no_rows' }));
    });

    it('a member demoted to viewer cannot delete even their own task', async () => {
      await admin(`UPDATE org_members SET role = 'viewer' WHERE user_id = $1`, [CAROL.id]);
      try {
        await asU(CAROL, async (db) => expect(await expectDenied(db, 'DELETE FROM tasks WHERE id = $1', [TASK_CAROL])).toEqual({ denied: true, by: 'no_rows' }));
      } finally {
        await admin(`UPDATE org_members SET role = 'member' WHERE user_id = $1`, [CAROL.id]);
      }
    });
  });
});
