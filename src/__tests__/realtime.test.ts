import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import { channel } from '../core/realtime/builders.js';
import { checkSchema, summarizeSchema } from '../cli/schema-check.js';
import { buildRuntimeSchema, generateSchemaFromIntrospection } from '../cli/init/schema-gen.js';

// Realtime: publication membership + realtime.messages policies (realtime.sql),
// validate checks, and the generated client / React Query helpers.

const root = join(import.meta.dirname, '..', '..');
const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixtureDir(): string {
  const dir = mkdtempSync(join(cacheDir, 'accessnexus-realtime-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  return dir;
}

function typecheck(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${d.file.fileName.split('/').pop()}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ` : '';
    return where + ts.flattenDiagnosticMessageText(d.messageText, '\n');
  });
}

const schema = () => defineSchema({
  profiles: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
  rooms: table({
    columns: { id: 'uuid', owner_id: 'uuid', title: 'text', views: 'int' },
    primaryKey: 'id',
    references: { owner_id: 'profiles.id' },
    policies: { select: policy.isOwner('owner_id') },
    realtime: true,
  }),
  counters: table({ columns: { id: 'bigint', n: 'int' }, primaryKey: 'id', policies: { select: policy.public() }, realtime: false }),
  notes: table({ columns: { id: 'uuid', body: 'text' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
}, {
  channels: {
    room: channel({ topic: 'room:{id}', table: 'rooms', broadcast: { receive: true, send: true }, presence: { receive: true } }),
    counter: channel({ topic: 'counter:{id}', table: 'counters', broadcast: { receive: true } }),
    inbox: channel({ topic: 'user:{uid}', broadcast: { receive: policy.custom('{uid} = (SELECT auth.uid())::text') } }),
    news: channel({ topic: 'news', broadcast: { receive: policy.public(), send: policy.hasRole('admin') } }),
  },
});

const adapter = () => new SupabaseAdapter({ deterministic: true });

describe('realtime.sql', () => {
  it('is not generated when the schema uses no Realtime', () => {
    const plain = defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) });
    expect(adapter().generateRealtimeSQL(plain)).toBeNull();
    expect(adapter().generatePolicies(plain).map((f) => f.path)).toEqual(['notes_rls.sql']);
  });

  it('adds realtime: true tables to the publication, drops realtime: false ones, leaves the rest alone', () => {
    const sql = adapter().generateRealtimeSQL(schema())!;
    expect(adapter().generatePolicies(schema()).map((f) => f.path)).toContain('realtime.sql');
    expect(sql).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rooms') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;`);
    expect(sql).toContain(`IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'counters') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.counters;`);
    expect(sql).not.toMatch(/tablename = 'notes'/);
    expect(sql).toContain('ALTER TABLE public.rooms REPLICA IDENTITY DEFAULT;');
    expect(sql).not.toContain('public.counters REPLICA IDENTITY');
    // A database without the publication gets a warning, not an error.
    expect(sql).toContain("RAISE WARNING 'AccessNexus: publication supabase_realtime does not exist");
  });

  it('honours replicaIdentity: full', () => {
    const s = defineSchema({ logs: table({ columns: { id: 'uuid' }, primaryKey: 'id', enableRLS: false, realtime: { replicaIdentity: 'full' } }) });
    expect(adapter().generateRealtimeSQL(s)).toContain('ALTER TABLE public.logs REPLICA IDENTITY FULL;');
  });

  it('writes one realtime.messages policy per granted extension/action, scoped to the topic and the row', () => {
    const sql = adapter().generateRealtimeSQL(schema())!;
    expect(sql).toContain(`CREATE POLICY "accessnexus_rt_room_broadcast_receive"
  ON realtime.messages FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND left(realtime.topic(), 5) = 'room:'
    AND length(realtime.topic()) > 5
    AND (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.rooms WHERE rooms.id = CASE WHEN substr(realtime.topic(), 6) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN substr(realtime.topic(), 6)::uuid END)
  );`);
    expect(sql).toContain(`CREATE POLICY "accessnexus_rt_room_broadcast_send"
  ON realtime.messages FOR INSERT
  TO authenticated
  WITH CHECK (`);
    // Not granted: dropped (so removing a rule revokes it), never created.
    expect(sql).toContain('DROP POLICY IF EXISTS "accessnexus_rt_room_presence_send" ON realtime.messages;');
    expect(sql).not.toContain('CREATE POLICY "accessnexus_rt_room_presence_send"');
    // bigint keys are matched without a cast that could raise on a bad topic.
    expect(sql).toContain("counters.id = CASE WHEN substr(realtime.topic(), 9) ~ '^[0-9]{1,18}$' THEN substr(realtime.topic(), 9)::bigint END");
    // {param} in policy.custom is the topic parameter.
    expect(sql).toContain('AND (substr(realtime.topic(), 6) = (SELECT auth.uid())::text)');
    // Fixed topic; public receive is TO public, admin-only send is TO authenticated.
    expect(sql).toMatch(/"accessnexus_rt_news_broadcast_receive"\n {2}ON realtime\.messages FOR SELECT\n {2}TO public\n {2}USING \(\n {4}realtime\.messages\.extension = 'broadcast'\n {4}AND realtime\.topic\(\) = 'news'\n {4}AND \(TRUE\)/);
    expect(sql).toMatch(/"accessnexus_rt_news_broadcast_send"\n {2}ON realtime\.messages FOR INSERT\n {2}TO authenticated/);
    expect(sql).toContain(`(((SELECT auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin')`);
    // Never a bare auth call.
    expect(sql).not.toMatch(/(?<!SELECT )auth\.(uid|jwt)\(\)/);
  });

  it('drops policies of removed channels (own prefix only)', () => {
    const sql = adapter().generateRealtimeSQL(defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) }, { channels: {} }))!;
    expect(sql).toContain("AND starts_with(policyname, 'accessnexus_rt_')");
    expect(sql).not.toContain('NOT IN');
    expect(sql).toContain("EXECUTE format('DROP POLICY %I ON realtime.messages', stale.policyname);");
    const full = adapter().generateRealtimeSQL(schema())!;
    expect(full).toContain("AND policyname NOT IN ('accessnexus_rt_room_broadcast_receive', 'accessnexus_rt_room_broadcast_send', 'accessnexus_rt_room_presence_receive'");
    expect(new SupabaseAdapter({ deterministic: true, policyPrefix: 'app' }).generateRealtimeSQL(schema())).toContain("starts_with(policyname, 'app_rt_')");
  });

  it('works in Database mode (no columns)', () => {
    const s = defineSchema({ rooms: { primaryKey: 'id', policies: { select: policy.isAuthenticated() }, realtime: true } } as any, {
      channels: { room: channel({ topic: 'room:{id}', table: 'rooms', broadcast: { receive: true } }) },
    });
    const sql = adapter().generateRealtimeSQL(s)!;
    expect(sql).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;');
    expect(sql).toContain('rooms.id::text = substr(realtime.topic(), 6)');
  });
});

describe('validate: realtime checks', () => {
  const codes = (s: unknown) => checkSchema(s).map((i) => `${i.severity}:${i.code}:${i.path}`);

  it('accepts the example', () => {
    expect(checkSchema(schema()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags tables nobody can receive and risky realtime settings', () => {
    const s = defineSchema({
      a: table({ columns: { id: 'uuid' }, primaryKey: 'id', realtime: true }),
      b: table({ columns: { id: 'uuid' }, primaryKey: 'id', enableRLS: false, realtime: true }),
      c: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.public() }, realtime: { replicaIdentity: 'full' } }),
      d: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.public() }, realtime: 'yes' as any }),
    });
    const found = codes(s);
    expect(found).toContain('warning:REALTIME_NOT_READABLE:a.realtime');
    expect(found).toContain('warning:REALTIME_RLS_DISABLED:b.realtime');
    expect(found).toContain('warning:REALTIME_REPLICA_FULL_WITH_RLS:c.realtime.replicaIdentity');
    expect(found).toContain('error:INVALID_REALTIME:d.realtime');
    expect(found.some((c) => c.includes('UNKNOWN_TABLE_KEY'))).toBe(false);
  });

  it('checks channels', () => {
    const tables = {
      rooms: table({ columns: { id: 'uuid', owner_id: 'uuid' }, primaryKey: 'id', policies: { select: policy.isOwner('owner_id') } }),
      hidden: table({ columns: { id: 'uuid' }, primaryKey: 'id' }),
      pairs: table({ columns: { a: 'uuid', b: 'uuid' }, compositePrimaryKey: ['a', 'b'], policies: { select: policy.public() } }),
    };
    const found = codes(defineSchema(tables, {
      channels: {
        bad_topic: channel({ topic: 'room/{id}', broadcast: { receive: true } }),
        no_prefix: channel({ topic: '{id}', broadcast: { receive: true } }),
        no_param: channel({ topic: 'room', table: 'rooms', broadcast: { receive: true } }),
        ghost: channel({ topic: 'g:{id}', table: 'nope', broadcast: { receive: true } }),
        hidden_room: channel({ topic: 'h:{id}', table: 'hidden', broadcast: { receive: true } }),
        pair: channel({ topic: 'p:{id}', table: 'pairs', broadcast: { receive: true } }),
        owner_rule: channel({ topic: 'o:{id}', broadcast: { receive: policy.isOwner('owner_id') } }),
        wrong_placeholder: channel({ topic: 'w:{id}', broadcast: { receive: policy.custom('{uid} = (SELECT auth.uid())::text') } }),
        unwrapped: channel({ topic: 'u:{id}', broadcast: { receive: policy.custom('{id} = auth.uid()::text') } }),
        open_send: channel({ topic: 'chat', broadcast: { receive: true, send: policy.public() } }),
        closed: channel({ topic: 'closed' }),
        typo: { topic: 'typo', brodcast: { receive: true } } as any,
        BadName: channel({ topic: 'x', broadcast: { receive: true } }),
      },
    }));
    expect(found).toEqual(expect.arrayContaining([
      'error:INVALID_CHANNEL:channels.bad_topic.topic',
      'error:INVALID_CHANNEL:channels.no_prefix.topic',
      'error:INVALID_CHANNEL:channels.no_param.topic',
      'error:UNKNOWN_TABLE:channels.ghost.table',
      'warning:CHANNEL_TABLE_NOT_READABLE:channels.hidden_room.table',
      'error:INVALID_CHANNEL:channels.pair.table',
      'error:CHANNEL_RULE_NOT_SUPPORTED:channels.owner_rule.broadcast.receive',
      'error:INVALID_CHANNEL:channels.wrong_placeholder.broadcast.receive',
      'warning:UNWRAPPED_AUTH_CALL:channels.unwrapped.broadcast.receive',
      'warning:CHANNEL_PUBLIC_SEND:channels.open_send.broadcast.send',
      'warning:CHANNEL_CLOSED:channels.closed',
      'error:INVALID_CHANNEL:channels.typo.brodcast',
      'error:INVALID_IDENTIFIER:channels.BadName',
    ]));
  });

  it('reports realtime and channels in the schema summary', () => {
    const summary = summarizeSchema(schema());
    expect(summary.channels).toEqual(['room', 'counter', 'inbox', 'news']);
    expect(summary.tables.map((t) => [t.name, t.realtime])).toEqual([
      ['profiles', null], ['rooms', true], ['counters', false], ['notes', null],
    ]);
  });
});

describe('generated client: Realtime', () => {
  it('adds subscribe only to realtime tables and typechecks against @supabase/supabase-js', () => {
    const dir = fixtureDir();
    const files = new SupabaseAdapter({ timestamps: false, reactQuery: true }).generateClient(schema());
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    writeFileSync(join(dir, 'use.ts'), `
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { QueryClient } from '@tanstack/react-query';
import { createAccessNexusClient } from './client.js';
import { createAccessNexusQueries } from './react-query.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
type Room = { id: string; owner_id: string; title: string; views: number };

const db = createAccessNexusClient(createClient('http://x', 'k'));
export const stop = db.rooms.subscribe((change) => {
  if (change.eventType === 'INSERT') assertType<Equal<typeof change.new, Room>>(true);
  if (change.eventType === 'DELETE') assertType<Equal<typeof change.old, Partial<Room>>>(true);
}, { filter: { owner_id: 'u' }, onStatus: (status) => console.log(status) });
assertType<Equal<typeof stop, () => void>>(true);
db.rooms.subscribe((change) => {
  assertType<Equal<typeof change.eventType, 'UPDATE'>>(true);
  assertType<Equal<typeof change.new, Room>>(true);
}, { event: 'UPDATE', filter: { views: { gt: 10 } } });
db.rooms.subscribe(() => {}, { filter: { title: ['a', 'b'] } });
// @ts-expect-error unknown column
db.rooms.subscribe(() => {}, { filter: { nope: 1 } });
// @ts-expect-error wrong value type
db.rooms.subscribe(() => {}, { filter: { views: 'x' } });
// @ts-expect-error notes has no realtime
db.notes.subscribe(() => {});

const room: RealtimeChannel = db.channels.room('00000000-0000-0000-0000-000000000000');
const news: RealtimeChannel = db.channels.news();
room.on('broadcast', { event: 'cursor' }, () => {}).subscribe();
void news;

const q = createAccessNexusQueries(db, { queryClient: new QueryClient() });
export const off: () => void = q.rooms.invalidateOnChange({ filter: { owner_id: 'u' } });
// @ts-expect-error notes has no realtime
q.notes.invalidateOnChange();
`);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);

  it('renames a topic parameter that is a reserved word', () => {
    const s = defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) }, {
      channels: { odd: channel({ topic: 'x:{new}', broadcast: { receive: true } }) },
    });
    const client = new SupabaseAdapter({ timestamps: false }).generateClient(s).find((f) => f.path === 'client.ts')!.content;
    expect(client).toContain("odd: (new_: string) =>");
    expect(client).toContain("openChannel(provider, 'x:' + new_)");
  });

  it('keeps the client free of Realtime code when unused', () => {
    const plain = defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) });
    const client = new SupabaseAdapter({ timestamps: false }).generateClient(plain).find((f) => f.path === 'client.ts')!.content;
    expect(client).not.toMatch(/subscribe|channel|Realtime/);
  });

  it('passes typescript-eslint recommended', async () => {
    const dir = fixtureDir();
    for (const f of new SupabaseAdapter({ timestamps: false, reactQuery: true }).generateClient(schema())) {
      writeFileSync(join(dir, f.path), f.content);
    }
    const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: tseslint.config(...tseslint.configs.recommended) as any });
    const results = await eslint.lintFiles(['client.ts', 'react-query.ts']);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath.split('/').pop()}:${m.line} ${m.ruleId}: ${m.message}`))).toEqual([]);
  }, 60_000);

  it('subscribes, filters, unsubscribes and opens private channels at runtime', async () => {
    const dir = fixtureDir();
    for (const f of new SupabaseAdapter({ timestamps: false, reactQuery: true }).generateClient(schema())) {
      if (!f.path.endsWith('.ts') || f.path === 'types.ts') continue;
      const js = ts.transpileModule(f.content, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(join(dir, f.path.replace(/\.ts$/, '.js')), js);
    }
    const { createAccessNexusClient } = await import(pathToFileURL(join(dir, 'client.js')).href);
    const { createAccessNexusQueries, accessNexusKeys } = await import(pathToFileURL(join(dir, 'react-query.js')).href);

    const calls: unknown[][] = [];
    let handler: ((payload: unknown) => void) | undefined;
    const makeChannel = (name: string, options?: object) => {
      calls.push(['channel', name, options]);
      const ch = {
        on: (type: string, filter: object, cb: (p: unknown) => void) => { calls.push(['on', type, filter]); handler = cb; return ch; },
        subscribe: (cb?: unknown) => { calls.push(['subscribe', typeof cb]); return ch; },
      };
      return ch;
    };
    const supabase = {
      auth: {}, from: () => ({}), rpc: () => ({}),
      channel: makeChannel,
      removeChannel: (ch: unknown) => { calls.push(['removeChannel', !!ch]); return Promise.resolve('ok'); },
    };
    const db = createAccessNexusClient(supabase);

    const seen: unknown[] = [];
    const stop = db.rooms.subscribe((c: unknown) => seen.push(c), { event: 'INSERT', filter: { owner_id: 'u1' } });
    expect(calls[0]).toEqual(['channel', expect.stringMatching(/^accessnexus:rooms:\d+$/), undefined]);
    expect(calls[1]).toEqual(['on', 'postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms', filter: 'owner_id=eq.u1' }]);
    expect(calls[2]).toEqual(['subscribe', 'undefined']);
    handler!({ eventType: 'INSERT', new: { id: 'r' } });
    expect(seen).toEqual([{ eventType: 'INSERT', new: { id: 'r' } }]);
    stop();
    expect(calls.at(-1)).toEqual(['removeChannel', true]);

    const filterOf = (filter: object) => {
      calls.length = 0;
      db.rooms.subscribe(() => {}, { filter });
      return (calls[1][2] as { filter?: string }).filter;
    };
    expect(filterOf({ title: ['a', 'b'] })).toBe('title=in.(a,b)');
    expect(filterOf({ views: { gte: 3 } })).toBe('views=gte.3');
    expect(filterOf({ views: undefined })).toBeUndefined();
    expect(() => filterOf({ views: 1, title: 'x' })).toThrow(/one column only/);
    expect(() => filterOf({ title: null })).toThrow(/on null/);

    calls.length = 0;
    db.channels.room('abc');
    db.channels.news();
    expect(calls).toEqual([
      ['channel', 'room:abc', { config: { private: true } }],
      ['channel', 'news', { config: { private: true } }],
    ]);

    // A provider without Realtime fails loudly instead of silently never firing.
    const bare = createAccessNexusClient({ auth: {}, from: () => ({}), rpc: () => ({}) });
    expect(() => bare.rooms.subscribe(() => {})).toThrow(/needs a Supabase client with Realtime/);
    expect(() => bare.channels.news()).toThrow(/needs a Supabase client with Realtime/);

    // React Query: every change invalidates the table (and tables embedding it).
    const invalidated: unknown[] = [];
    const queryClient = { invalidateQueries: async ({ queryKey }: { queryKey: unknown }) => { invalidated.push(queryKey); } };
    const q = createAccessNexusQueries(db, { queryClient });
    calls.length = 0;
    const off = q.rooms.invalidateOnChange({ filter: { owner_id: 'u1' } });
    expect(calls[1]).toEqual(['on', 'postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'owner_id=eq.u1' }]);
    handler!({ eventType: 'UPDATE' });
    await new Promise((r) => setTimeout(r, 0));
    expect(invalidated).toEqual([accessNexusKeys.rooms.all]);
    off();
    expect(calls.at(-1)).toEqual(['removeChannel', true]);
    expect(() => createAccessNexusQueries(db).rooms.invalidateOnChange()).toThrow(/needs createAccessNexusQueries/);
  });
});

describe('example schema', () => {
  it('generates realtime.sql in the committed output', () => {
    const sql = readFileSync(join(root, 'generated', 'policies', 'realtime.sql'), 'utf-8');
    expect(sql).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;');
    expect(sql).toContain('CREATE POLICY "accessnexus_rt_project_room_presence_send"');
  });
});

describe('init --db-url import', () => {
  const tbl = (name: string, extra: object = {}) => ({
    name,
    columns: [{ column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO', column_default: null, ordinal_position: 1 }],
    primaryKey: 'id',
    foreignKeys: [],
    uniqueColumns: [],
    policies: [],
    rlsEnabled: true,
    ...extra,
  }) as any;

  it('imports publication membership and replica identity, and lists realtime.messages policies', () => {
    const src = generateSchemaFromIntrospection({
      policyPrefix: 'accessnexus',
      tables: [tbl('rooms', { realtime: true }), tbl('logs', { realtime: true, replicaIdentityFull: true }), tbl('notes', { replicaIdentityFull: true })],
      realtimePolicies: ['room members can listen', 'admins send'],
    });
    expect(src).toMatch(/rooms: table\(\{[\s\S]*?realtime: true,\n {2}\}\),/);
    expect(src).toMatch(/logs: table\(\{[\s\S]*?realtime: \{ replicaIdentity: 'full' \},\n {2}\}\),/);
    expect(src).not.toMatch(/notes: table\(\{[^}]*realtime/);
    expect(src).toContain('// realtime.messages has 2 Broadcast/Presence policies (not imported; push leaves');
    expect(src).toContain('// them as they are): room members can listen, admins send.');
    expect(buildRuntimeSchema([tbl('rooms', { realtime: true }), tbl('notes')])).toMatchObject({ rooms: { realtime: true }, notes: {} });
    expect(buildRuntimeSchema([tbl('notes')]).notes.realtime).toBeUndefined();
  });
});
