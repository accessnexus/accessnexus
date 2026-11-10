// Realtime against a real Supabase Postgres: publication membership and the
// realtime.messages policies that authorize Broadcast / Presence. Skipped unless
// ACCESSNEXUS_TEST_DB_URL is set (same setup as push.integration.test.ts).
//
// The bare image has the supabase_realtime publication and the realtime schema,
// but realtime.messages and realtime.topic() come from the Realtime service. Create
// stand-ins as supabase_admin (owned by postgres, which may manage their policies
// on Supabase), e.g.:
//
//   docker exec -i accessnexus-test-pg psql -U supabase_admin -d postgres <<'SQL'
//   CREATE TABLE IF NOT EXISTS realtime.messages (id uuid NOT NULL DEFAULT gen_random_uuid(), topic text NOT NULL,
//     extension text NOT NULL, payload jsonb, event text, private boolean DEFAULT false,
//     inserted_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
//   ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
//   CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS
//     $$ SELECT nullif(current_setting('realtime.topic', true), '')::text $$;
//   GRANT USAGE ON SCHEMA realtime TO postgres, anon, authenticated;
//   GRANT SELECT, INSERT ON realtime.messages TO anon, authenticated;
//   GRANT EXECUTE ON FUNCTION realtime.topic() TO anon, authenticated;
//   ALTER TABLE realtime.messages OWNER TO postgres;
//   SQL
//
// The tests DROP every table in the public schema of that database.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/run.js';

const DB_URL = process.env.ACCESSNEXUS_TEST_DB_URL;
const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const ROOM_A = 'aaaaaaaa-0000-0000-0000-000000000001';

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
      FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' LOOP
        EXECUTE format('DROP POLICY %I ON realtime.messages', r.policyname);
      END LOOP;
    END $$;
    DELETE FROM realtime.messages;
  `);
}

/**
 * Run `sql` as an API user on a channel topic, the way Realtime authorizes a
 * join / send: role + JWT claims + the realtime.topic setting, in a transaction.
 */
async function onTopic(
  userId: string | null,
  topic: string,
  sql: string,
  opts: { appRole?: string } = {},
): Promise<{ rows: any[] }> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const claims = JSON.stringify({
      sub: userId,
      role: userId ? 'authenticated' : 'anon',
      ...(opts.appRole ? { app_metadata: { role: opts.appRole } } : {}),
    });
    await client.query(`SET LOCAL ROLE ${userId ? 'authenticated' : 'anon'}`);
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('realtime.topic', $3, true)`,
      [claims, userId ?? '', topic],
    );
    const result = await client.query(sql);
    await client.query('ROLLBACK');
    return { rows: result.rows ?? [] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Can this user receive on `topic` (SELECT policy on realtime.messages)? */
async function canReceive(userId: string | null, topic: string, extension: string, opts: { appRole?: string } = {}): Promise<boolean> {
  const { rows } = await onTopic(userId, topic, `SELECT count(*)::int AS n FROM realtime.messages WHERE extension = '${extension}'`, opts);
  return rows[0].n > 0;
}

/** Can this user send on `topic` (INSERT policy on realtime.messages)? */
async function canSend(userId: string | null, topic: string, extension: string, opts: { appRole?: string } = {}): Promise<boolean> {
  try {
    await onTopic(userId, topic, `INSERT INTO realtime.messages (topic, extension, event, payload) VALUES ('${topic}', '${extension}', 'e', '{}')`, opts);
    return true;
  } catch (err) {
    if (/row-level security/.test(String((err as Error).message))) return false;
    throw err;
  }
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
  writeFileSync(join(cwd, 'accessnexus.schema.ts'), `import { defineSchema, table, policy, channel } from '${SRC_INDEX}';\n${body}`);
}

async function published(): Promise<string[]> {
  const { rows } = await admin.query(
    `SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r: any) => r.tablename);
}

async function channelPolicies(): Promise<string[]> {
  const { rows } = await admin.query(
    `SELECT policyname FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' ORDER BY policyname`,
  );
  return rows.map((r: any) => r.policyname);
}

const schemaV1 = `
export default defineSchema({
  rooms: table({
    columns: { id: 'uuid', owner_id: 'uuid', title: 'text' },
    primaryKey: 'id',
    policies: { select: policy.isOwner('owner_id'), insert: policy.isOwner('owner_id') },
    realtime: true,
  }),
  counters: table({
    columns: { id: 'bigint', n: 'int' },
    primaryKey: 'id',
    policies: { select: policy.public() },
    realtime: { replicaIdentity: 'default' },
  }),
}, {
  channels: {
    room: channel({ topic: 'room:{id}', table: 'rooms', broadcast: { receive: true, send: true }, presence: { receive: true } }),
    counter: channel({ topic: 'counter:{id}', table: 'counters', broadcast: { receive: true } }),
    inbox: channel({ topic: 'user:{uid}', broadcast: { receive: policy.custom('{uid} = (SELECT auth.uid())::text') } }),
    news: channel({ topic: 'news', broadcast: { receive: policy.public(), send: policy.hasRole('admin') } }),
  },
});`;

describe.skipIf(!DB_URL)('Realtime against a real Supabase Postgres', () => {
  beforeAll(async () => {
    pg = await import('pg');
    pg = pg.default ?? pg;
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock(727274)');
    const { rows } = await admin.query(
      `SELECT to_regclass('realtime.messages') IS NOT NULL AS messages, to_regprocedure('realtime.topic()') IS NOT NULL AS topic,
              to_regprocedure('auth.jwt()') IS NOT NULL AS jwt`,
    );
    if (!rows[0].messages || !rows[0].topic || !rows[0].jwt) {
      throw new Error('realtime.messages / realtime.topic() / auth.jwt() missing: create the stand-ins (see the top of this file).');
    }
  }, 600_000);

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    await resetDatabase();
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-rt-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('publishes tables and enforces channel access through the row RLS', async () => {
    writeSchema(schemaV1);
    expect((await cli('generate')).code).toBe(0);
    const pushed = await cli('push');
    expect(pushed.code).toBe(0);
    expect(pushed.json.applied).toContain('generated/policies/realtime.sql');

    expect(await published()).toEqual(['counters', 'rooms']);
    const identity = await admin.query(`SELECT relreplident FROM pg_class WHERE oid = 'public.rooms'::regclass`);
    expect(identity.rows[0].relreplident).toBe('d');

    await admin.query(`INSERT INTO rooms (id, owner_id, title) VALUES ('${ROOM_A}', '${ALICE}', 'a')`);
    await admin.query(`INSERT INTO counters (id, n) OVERRIDING SYSTEM VALUE VALUES (7, 0)`);
    // Messages to receive (Realtime reads them under the subscriber's policies).
    await admin.query(`INSERT INTO realtime.messages (topic, extension, event) VALUES ('x', 'broadcast', 'e'), ('x', 'presence', 'p')`);

    // room:{id} follows rooms' SELECT policy (owner only).
    expect(await canReceive(ALICE, `room:${ROOM_A}`, 'broadcast')).toBe(true);
    expect(await canSend(ALICE, `room:${ROOM_A}`, 'broadcast')).toBe(true);
    expect(await canReceive(ALICE, `room:${ROOM_A}`, 'presence')).toBe(true);
    expect(await canSend(ALICE, `room:${ROOM_A}`, 'presence')).toBe(false);
    expect(await canReceive(BOB, `room:${ROOM_A}`, 'broadcast')).toBe(false);
    expect(await canSend(BOB, `room:${ROOM_A}`, 'broadcast')).toBe(false);
    expect(await canReceive(null, `room:${ROOM_A}`, 'broadcast')).toBe(false);
    // A malformed or unknown topic is denied, never an error.
    expect(await canReceive(ALICE, 'room:not-a-uuid', 'broadcast')).toBe(false);
    expect(await canReceive(ALICE, 'room:', 'broadcast')).toBe(false);
    expect(await canReceive(ALICE, 'room:bbbbbbbb-0000-0000-0000-000000000002', 'broadcast')).toBe(false);
    expect(await canReceive(ALICE, `lobby:${ROOM_A}`, 'broadcast')).toBe(false);

    // bigint key; counters are readable by everyone, but `true` still needs a user.
    expect(await canReceive(BOB, 'counter:7', 'broadcast')).toBe(true);
    expect(await canReceive(BOB, 'counter:8', 'broadcast')).toBe(false);
    expect(await canReceive(BOB, 'counter:99999999999999999999999', 'broadcast')).toBe(false);
    expect(await canReceive(null, 'counter:7', 'broadcast')).toBe(false);

    // {uid} placeholder: each user only on their own inbox.
    expect(await canReceive(ALICE, `user:${ALICE}`, 'broadcast')).toBe(true);
    expect(await canReceive(BOB, `user:${ALICE}`, 'broadcast')).toBe(false);

    // Fixed topic: anon receives, only app admins send.
    expect(await canReceive(null, 'news', 'broadcast')).toBe(true);
    expect(await canSend(ALICE, 'news', 'broadcast')).toBe(false);
    expect(await canSend(ALICE, 'news', 'broadcast', { appRole: 'admin' })).toBe(true);
    expect(await canReceive(null, 'newsletter', 'broadcast')).toBe(false);

    // Unchanged schema: realtime.sql is not re-applied.
    expect((await cli('push')).json.applied).toEqual([]);
  }, 120_000);

  it('unpublishes realtime: false tables and drops removed channels, keeping foreign policies', async () => {
    writeSchema(schemaV1);
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    // A policy the app wrote by hand (not our prefix) must survive.
    await admin.query(`CREATE POLICY "my_own_policy" ON realtime.messages FOR SELECT TO authenticated USING (false)`);
    await admin.query(`ALTER TABLE public.counters REPLICA IDENTITY FULL`);

    writeSchema(schemaV1
      .replace("realtime: true,\n  }),", 'realtime: false,\n  }),')
      .replace(/ {4}news: channel\([^\n]*\n/, '')
      .replace(', presence: { receive: true }', ''));
    expect((await cli('generate')).code).toBe(0);
    const pushed = await cli('push');
    expect(pushed.code).toBe(0);
    expect(pushed.json.applied).toEqual(['generated/policies/realtime.sql']);

    expect(await published()).toEqual(['counters']);
    const identity = await admin.query(`SELECT relreplident FROM pg_class WHERE oid = 'public.counters'::regclass`);
    expect(identity.rows[0].relreplident).toBe('d');
    expect(await channelPolicies()).toEqual([
      'accessnexus_rt_counter_broadcast_receive',
      'accessnexus_rt_inbox_broadcast_receive',
      'accessnexus_rt_room_broadcast_receive',
      'accessnexus_rt_room_broadcast_send',
      'my_own_policy',
    ]);

    // channels: {} removes every channel policy of the prefix.
    writeSchema(schemaV1.replace(/channels: \{[\s\S]*\n {2}\},\n\}\);/, 'channels: {},\n});'));
    expect((await cli('generate')).code).toBe(0);
    expect((await cli('push')).code).toBe(0);
    expect(await channelPolicies()).toEqual(['my_own_policy']);
  }, 120_000);
});
