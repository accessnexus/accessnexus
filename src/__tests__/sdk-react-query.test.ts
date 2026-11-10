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
import { rpc } from '../core/rpc/builders.js';
import exampleSchema from '../../examples/fullstack-saas.schema.js';

// Contract of `react-query.ts` (adapterOptions.reactQuery) against the real
// @tanstack/react-query v5 and @supabase/supabase-js types (devDependencies).
// Fixtures live under node_modules/ so they resolve the repo's packages.

const root = join(import.meta.dirname, '..', '..');
const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixtureDir(): string {
  const dir = mkdtempSync(join(cacheDir, 'accessnexus-react-query-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  return dir;
}

function typecheck(files: string[], resolution: 'node' | 'bundler' = 'node'): string[] {
  const program = ts.createProgram(files, {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: resolution === 'bundler' ? ts.ModuleKind.ESNext : ts.ModuleKind.NodeNext,
    moduleResolution: resolution === 'bundler' ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${d.file.fileName.split('/').pop()}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ` : '';
    return where + ts.flattenDiagnosticMessageText(d.messageText, '\n');
  });
}

const schema = defineSchema({
  profiles: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id', policies: { select: policy.public() } }),
  docs: table({
    columns: { id: 'uuid', owner_id: 'uuid', slug: 'text', views: 'int', deleted_at: 'timestamptz?' },
    primaryKey: 'id',
    references: { owner_id: 'profiles.id' },
    softDelete: 'deleted_at',
    policies: { select: policy.isOwner('owner_id') },
  }),
}, {
  rpcs: {
    ping: rpc({ returns: 'text', language: 'sql', body: `SELECT 'pong'` }),
    add: rpc({ args: { a: 'int', b: 'int' }, returns: 'int', language: 'sql', body: 'SELECT a + b' }),
    my_docs: rpc({ returns: { setof: 'docs' }, language: 'sql', body: 'SELECT * FROM docs' }),
    doc_stats: rpc({ returns: { table: { slug: 'text', views: 'int' } }, language: 'sql', body: 'SELECT slug, views FROM docs' }),
  },
});

function generate(dir: string, s: Parameters<SupabaseAdapter['generateClient']>[0] = schema, extra: object = {}): string[] {
  const files = new SupabaseAdapter({ timestamps: false, reactQuery: true, ...extra }).generateClient(s);
  for (const f of files) writeFileSync(join(dir, f.path), f.content);
  return files.map((f) => f.path);
}

const usage = `
import { createClient } from '@supabase/supabase-js';
import { QueryClient, useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createAccessNexusClient } from './client.js';
import { accessNexusKeys, createAccessNexusQueries, type AccessNexusQueries } from './react-query.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
type Profile = { id: string; name: string };
type Doc = { id: string; owner_id: string; slug: string; views: number; deleted_at: string | null };

const queryClient = new QueryClient();
const q = createAccessNexusQueries(createAccessNexusClient(createClient('http://x', 'k')), { queryClient });
export const typed: AccessNexusQueries = q;

export function useEverything() {
  const many = useQuery(q.docs.findMany({ owner_id: 'o' }, { columns: ['id', 'slug'], include: { owner: true } }));
  assertType<Equal<typeof many.data, (Pick<Doc, 'id' | 'slug'> & { owner: Profile | null })[] | undefined>>(true);
  const one = useSuspenseQuery(q.docs.findById('x'));
  assertType<Equal<typeof one.data, Doc | null>>(true);
  const byFilter = useQuery({ ...q.profiles.findOne({ name: 'n' }), enabled: false });
  assertType<Equal<typeof byFilter.data, Profile | null | undefined>>(true);
  // @ts-expect-error unknown column
  q.docs.findMany({}, { columns: ['nope'] });
  // @ts-expect-error unknown filter column
  q.docs.findMany({ nope: 1 });

  const create = useMutation(q.docs.create());
  create.mutate({ owner_id: 'o', slug: 's', views: 0 });
  assertType<Equal<typeof create.data, Doc | undefined>>(true);
  const update = useMutation({ ...q.docs.update(), onError: (e) => console.error(e) });
  update.mutate({ id: 'x', data: { views: 2 } });
  const remove = useMutation(q.docs.delete());
  remove.mutate('x');
  const many2 = useMutation(q.docs.updateMany());
  many2.mutate({ filter: { owner_id: 'o' }, data: { views: 0 } });
  assertType<Equal<typeof many2.data, Doc[] | undefined>>(true);
  const delOne = useMutation(q.docs.deleteOne());
  delOne.mutate({ slug: 's' });

  const added = useQuery(q.rpc.add.query({ a: 1, b: 2 }));
  assertType<Equal<typeof added.data, number | null | undefined>>(true);
  const ping = useQuery(q.rpc.ping.query());
  // RETURNS SETOF / TABLE: never null (an empty result is []).
  const mine = useSuspenseQuery(q.rpc.my_docs.query());
  assertType<Equal<typeof mine.data, Doc[]>>(true);
  const stats = useSuspenseQuery(q.rpc.doc_stats.query());
  assertType<Equal<typeof stats.data, { slug: string; views: number }[]>>(true);
  const addMut = useMutation(q.rpc.add.mutation());
  addMut.mutate({ a: 1, b: 2 });

  const cached = queryClient.getQueryData(q.docs.findById('x').queryKey);
  assertType<Equal<typeof cached, Doc | null | undefined>>(true);
  return [ping.data, accessNexusKeys.docs.all];
}
`;

describe('generated TanStack Query helpers', () => {
  it('is not emitted unless reactQuery is enabled', () => {
    const paths = new SupabaseAdapter({ timestamps: false }).generateClient(schema).map((f) => f.path);
    expect(paths).toEqual(['types.ts', 'client.ts']);
  });

  it('typechecks against @tanstack/react-query v5 (manual mode, node and bundler resolution)', () => {
    const dir = fixtureDir();
    expect(generate(dir)).toEqual(['types.ts', 'client.ts', 'react-query.ts']);
    writeFileSync(join(dir, 'use.ts'), usage);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
    expect(typecheck([join(dir, 'use.ts')], 'bundler')).toEqual([]);
  }, 60_000);

  it('typechecks the example schema', () => {
    const dir = fixtureDir();
    generate(dir, exampleSchema);
    writeFileSync(join(dir, 'use.ts'), `
import { QueryClient, useQuery } from '@tanstack/react-query';
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './client.js';
import { createAccessNexusQueries } from './react-query.js';
const q = createAccessNexusQueries(createAccessNexusClient(createClient('http://x', 'k')), { queryClient: new QueryClient() });
export const useTasks = () => useQuery(q.tasks.findMany({ project_id: 'p' }, { include: { project: true } }));
`);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);

  it('typechecks in Database mode', () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, 'database.types.ts'), `
export type Database = {
  public: {
    Tables: {
      profiles: { Row: { id: string; name: string }; Insert: { id?: string; name: string }; Update: { id?: string; name?: string }; Relationships: [] };
      docs: { Row: { id: string; owner_id: string; slug: string }; Insert: { id?: string; owner_id: string; slug: string }; Update: { id?: string; owner_id?: string; slug?: string }; Relationships: [] };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
`);
    const dbSchema = defineSchema({
      profiles: { primaryKey: 'id', policies: { select: policy.public() } },
      docs: { primaryKey: 'id', references: { owner_id: 'profiles.id' }, policies: { select: policy.isOwner('owner_id') } },
    } as any);
    expect(generate(dir, dbSchema, { databaseTypes: './database.types.js' })).toEqual(['client.ts', 'react-query.ts']);
    writeFileSync(join(dir, 'use.ts'), `
import { createBrowserClient } from '@supabase/ssr';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createAccessNexusClient } from './client.js';
import { createAccessNexusQueries } from './react-query.js';
import type { Database } from './database.types.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
type Row = Database['public']['Tables']['docs']['Row'];
const q = createAccessNexusQueries(createAccessNexusClient(createBrowserClient<Database>('http://x', 'k')));
export function useDocs() {
  const docs = useQuery(q.docs.findMany({ owner_id: 'o' }, { columns: ['id'] }));
  assertType<Equal<typeof docs.data, Pick<Row, 'id'>[] | undefined>>(true);
  const create = useMutation(q.docs.create());
  create.mutate({ owner_id: 'o', slug: 's' });
  return docs;
}
`);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);

  it('passes typescript-eslint recommended', async () => {
    const dir = fixtureDir();
    generate(dir, exampleSchema);
    const eslint = new ESLint({
      cwd: dir,
      overrideConfigFile: true,
      overrideConfig: tseslint.config(...tseslint.configs.recommended) as any,
    });
    const results = await eslint.lintFiles(['react-query.ts']);
    expect(results.flatMap((r) => r.messages.map((m) => `${m.line} ${m.ruleId}: ${m.message}`))).toEqual([]);
  }, 60_000);

  it('unwraps results, throws Supabase errors and invalidates affected tables', async () => {
    const dir = fixtureDir();
    generate(dir);
    for (const name of ['client', 'react-query']) {
      const js = ts.transpileModule(readFileSync(join(dir, `${name}.ts`), 'utf-8'), {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      writeFileSync(join(dir, `${name}.js`), js);
    }
    const { createAccessNexusClient } = await import(pathToFileURL(join(dir, 'client.js')).href);
    const { createAccessNexusQueries, accessNexusKeys } = await import(pathToFileURL(join(dir, 'react-query.js')).href);

    let next: { data: unknown; error: unknown } = { data: null, error: null };
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'match', 'eq', 'is', 'single', 'maybeSingle']) {
      builder[m] = () => builder;
    }
    builder.then = (resolve: (v: unknown) => void) => resolve(next);
    const rpcCalls: unknown[] = [];
    const supabase = { auth: {}, from: () => builder, rpc: (...args: unknown[]) => { rpcCalls.push(args); return builder; } };

    const invalidated: unknown[] = [];
    const queryClient = { invalidateQueries: async ({ queryKey }: { queryKey: unknown }) => { invalidated.push(queryKey); } };
    const q = createAccessNexusQueries(createAccessNexusClient(supabase), { queryClient });

    const list = q.docs.findMany({ owner_id: 'o' }, { columns: ['id'] });
    expect(list.queryKey).toEqual(['accessnexus', 'docs', 'list', { filter: { owner_id: 'o' }, options: { columns: ['id'] } }]);
    expect(q.docs.findById('x').queryKey).toEqual(['accessnexus', 'docs', 'byId', 'x', {}]);
    expect(q.rpc.ping.query().queryKey).toEqual(['accessnexus', 'rpc', 'ping', {}]);

    next = { data: null, error: null };
    expect(await list.queryFn()).toEqual([]);
    next = { data: [{ id: '1' }], error: null };
    expect(await list.queryFn()).toEqual([{ id: '1' }]);
    const pgError = { code: '42501', message: 'denied' };
    next = { data: null, error: pgError };
    await expect(list.queryFn()).rejects.toBe(pgError);

    // A write on profiles also refreshes docs, whose queries can embed a profile.
    const createProfile = q.profiles.create();
    expect(createProfile.mutationKey).toEqual(['accessnexus', 'profiles', 'create']);
    next = { data: { id: 'p', name: 'n' }, error: null };
    expect(await createProfile.mutationFn({ name: 'n' })).toEqual({ id: 'p', name: 'n' });
    await createProfile.onSuccess();
    expect(invalidated).toEqual([accessNexusKeys.profiles.all, accessNexusKeys.docs.all]);

    invalidated.length = 0;
    await q.docs.delete().onSuccess();
    expect(invalidated).toEqual([accessNexusKeys.docs.all]);

    invalidated.length = 0;
    next = { data: 3, error: null };
    const add = q.rpc.add.mutation();
    expect(await add.mutationFn({ a: 1, b: 2 })).toBe(3);
    expect(rpcCalls.at(-1)).toEqual(['add', { a: 1, b: 2 }]);
    await add.onSuccess();
    expect(invalidated).toEqual([['accessnexus']]);

    // The filtered-write guard of client.ts still applies.
    await expect(Promise.resolve().then(() => q.docs.deleteMany().mutationFn({}))).rejects.toThrow(/at least one column/);

    // Without a queryClient, mutations invalidate nothing (and do not throw).
    const bare = createAccessNexusQueries(createAccessNexusClient(supabase));
    await expect(bare.docs.create().onSuccess()).resolves.toBeUndefined();
  });
});
