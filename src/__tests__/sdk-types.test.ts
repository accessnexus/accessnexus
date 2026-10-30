import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import { generateFrameworkFiles } from '../cli/init/templates.js';

// Type-level contract of the generated SDK against the real @supabase/supabase-js
// and @supabase/ssr types (devDependencies), plus its runtime query-builder calls.
// Fixtures live under node_modules/ so they resolve the repo's @supabase packages.

const root = join(import.meta.dirname, '..', '..');
const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixtureDir(): string {
  const dir = mkdtempSync(join(cacheDir, 'accessnexus-sdk-types-'));
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

function write(dir: string, files: Array<{ path: string; content: string }>): void {
  for (const f of files) writeFileSync(join(dir, f.path), f.content);
}

const manualSchema = defineSchema({
  profiles: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id', policies: { select: policy.public() } }),
  docs: table({
    columns: {
      id: 'uuid',
      owner_id: 'uuid',
      slug: 'text',
      status: "enum('draft','published')",
      meta: 'jsonb?',
      payload: 'jsonb',
      score: 'numeric?',
      views: 'int',
      tags: 'text[]?',
      published: { type: 'boolean', default: 'false' },
      created_at: { type: 'timestamptz', default: 'now()' },
      deleted_at: 'timestamptz?',
    },
    primaryKey: 'id',
    references: { owner_id: 'profiles.id' },
    softDelete: 'deleted_at',
    policies: { select: policy.isOwner('owner_id') },
  }),
});

// What `supabase gen types typescript` emits for the same two tables.
const supabaseStyleTypes = `
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; name: string }
        Insert: { id?: string; name: string }
        Update: { id?: string; name?: string }
        Relationships: []
      }
      docs: {
        Row: {
          id: string
          owner_id: string
          slug: string
          status: Database["public"]["Enums"]["docs_status"]
          meta: Json | null
          payload: Json
          score: number | null
          views: number
          tags: string[] | null
          published: boolean
          created_at: string
          deleted_at: string | null
        }
        Insert: {
          id?: string
          owner_id: string
          slug: string
          status: Database["public"]["Enums"]["docs_status"]
          meta?: Json | null
          payload: Json
          score?: number | null
          views: number
          tags?: string[] | null
          published?: boolean
          created_at?: string
          deleted_at?: string | null
        }
        Update: {
          id?: string
          owner_id?: string
          slug?: string
          status?: Database["public"]["Enums"]["docs_status"]
          meta?: Json | null
          payload?: Json
          score?: number | null
          views?: number
          tags?: string[] | null
          published?: boolean
          created_at?: string
          deleted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "docs_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { docs_status: "draft" | "published" }
    CompositeTypes: { [_ in never]: never }
  }
}
`;

describe('generated SDK types (manual mode)', () => {
  it('typechecks against real Supabase clients and Supabase-generated row types', () => {
    const dir = fixtureDir();
    write(dir, new SupabaseAdapter({ timestamps: false }).generateClient(manualSchema));
    writeFileSync(join(dir, 'supabase.types.ts'), supabaseStyleTypes);
    writeFileSync(join(dir, 'use.ts'), `
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { createAccessNexusClient, type AccessNexusClient, type Json } from './client.js';
import type { Database, Docs, DocsCreate } from './types.js';
import type { Database as SupabaseDb, Json as SupabaseJson } from './supabase.types.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;

// 1. auth keeps the provider's type (supabase-js and @supabase/ssr).
const plain = createAccessNexusClient(createClient<SupabaseDb>('http://x', 'k'));
export const p1 = plain.auth.signInWithOAuth({ provider: 'github' });
export const p2 = plain.auth.getUser();
const browser = createAccessNexusClient(createBrowserClient<SupabaseDb>('http://x', 'k'));
export const b1 = browser.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'http://x/cb' } });
const server = createAccessNexusClient(createServerClient<SupabaseDb>('http://x', 'k', { cookies: { getAll: () => [], setAll: () => undefined } }));
export const s1 = server.auth.exchangeCodeForSession('code');
// The generated (manual-mode) Database is accepted by supabase-js too.
const own = createAccessNexusClient(createClient<Database>('http://x', 'k'));
export const o1 = own.auth.signOut();
type Typed = AccessNexusClient<SupabaseClient<SupabaseDb>>;
export const t1 = (c: Typed) => c.auth.onAuthStateChange(() => undefined);

// 2. Json is Supabase's Json; rows/inserts are assignable both ways.
assertType<Equal<Json, SupabaseJson>>(true);
type SbRow = SupabaseDb['public']['Tables']['docs']['Row'];
type SbInsert = SupabaseDb['public']['Tables']['docs']['Insert'];
export const r1: SbRow = {} as Docs;
export const r2: Docs = {} as SbRow;
export const i1: SbInsert = {} as DocsCreate;
export const i2: DocsCreate = {} as SbInsert;
assertType<Equal<Docs['meta'], Json | null>>(true);
export const anyJson: Docs['payload'][] = [[1, 'a', null], { a: { b: [true] } }, 'x', 3, false, null];

// 3. findOne / findById resolve to Row | null.
export async function lookups() {
  const one = await plain.docs.findOne({ slug: 'hello' });
  assertType<Equal<typeof one.data, Docs | null>>(true);
  const byId = await plain.docs.findById('id');
  assertType<Equal<typeof byId.data, Docs | null>>(true);

  // 4. columns narrows the row type, including with include.
  const few = await plain.docs.findMany({ status: 'draft' }, { columns: ['id', 'slug'] });
  assertType<Equal<typeof few.data, Pick<Docs, 'id' | 'slug'>[] | null>>(true);
  const fewOne = await plain.docs.findOne({ slug: 'x' }, { columns: ['id'] });
  assertType<Equal<typeof fewOne.data, Pick<Docs, 'id'> | null>>(true);
  const withOwner = await plain.docs.findById('id', { columns: ['id'], include: { owner: true } });
  if (withOwner.data) {
    const id: string = withOwner.data.id;
    const owner = withOwner.data.owner?.name;
    // @ts-expect-error slug was not selected
    void withOwner.data.slug;
    void id; void owner;
  }
  // @ts-expect-error unknown column name
  await plain.docs.findMany({}, { columns: ['id', 'nope'] });
  // @ts-expect-error unknown column name
  await plain.profiles.findOne({ id: 'x' }, { columns: ['email'] });
}
`);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);

  it('runs the expected query-builder calls', async () => {
    const dir = fixtureDir();
    write(dir, new SupabaseAdapter({ timestamps: false }).generateClient(manualSchema));
    const js = ts.transpileModule(readFileSync(join(dir, 'client.ts'), 'utf-8'), {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    writeFileSync(join(dir, 'client.mjs'), js);
    const { createAccessNexusClient } = await import(pathToFileURL(join(dir, 'client.mjs')).href);

    const calls: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'match', 'eq', 'is', 'single', 'maybeSingle']) {
      builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder; };
    }
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    const auth = { signInWithOAuth: () => 'ok' };
    const supabase = {
      auth,
      from: (t: string) => { calls.push(['from', t]); return builder; },
      rpc: () => builder,
    };
    const client = createAccessNexusClient(supabase);
    expect(client.auth).toBe(auth);

    const run = async (fn: () => PromiseLike<unknown>) => { calls.length = 0; await fn(); return [...calls]; };

    expect(await run(() => client.docs.findOne({ slug: 'a' }))).toEqual([
      ['from', 'docs'], ['select', '*'], ['is', 'deleted_at', null], ['match', { slug: 'a' }], ['maybeSingle'],
    ]);
    expect(await run(() => client.docs.findOne({ slug: 'a' }, { columns: ['id', 'slug'], include: { owner: true } }))).toEqual([
      ['from', 'docs'], ['select', 'id, slug, owner:profiles!docs_owner_id_fkey(*)'], ['is', 'deleted_at', null],
      ['match', { slug: 'a' }], ['maybeSingle'],
    ]);
    expect(await run(() => client.docs.findById('1', { columns: ['id'] }))).toEqual([
      ['from', 'docs'], ['select', 'id'], ['eq', 'id', '1'], ['is', 'deleted_at', null], ['maybeSingle'],
    ]);
    expect(await run(() => client.docs.findMany(undefined, { columns: [] }))).toEqual([
      ['from', 'docs'], ['select', '*'], ['is', 'deleted_at', null], ['match', {}],
    ]);
    expect(await run(() => client.profiles.findMany({ name: 'x' }, { columns: ['id', 'name'] }))).toEqual([
      ['from', 'profiles'], ['select', 'id, name'], ['match', { name: 'x' }],
    ]);
    expect(await run(() => client.profiles.findById('1'))).toEqual([
      ['from', 'profiles'], ['select', '*'], ['eq', 'id', '1'], ['maybeSingle'],
    ]);
    // writes still return the single written row
    expect(await run(() => client.profiles.update('1', { name: 'y' }))).toEqual([
      ['from', 'profiles'], ['update', { name: 'y' }], ['eq', 'id', '1'], ['select'], ['single'],
    ]);
  });
});

describe('generated SDK types (Database mode)', () => {
  it('uses the Supabase Database row types verbatim', () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, 'database.types.ts'), supabaseStyleTypes);
    const schema = defineSchema({
      profiles: { primaryKey: 'id', policies: { select: policy.public() } },
      docs: { primaryKey: 'id', references: { owner_id: 'profiles.id' }, policies: { select: policy.isOwner('owner_id') } },
    } as any);
    write(dir, new SupabaseAdapter({ timestamps: false, databaseTypes: './database.types.js' }).generateClient(schema));
    writeFileSync(join(dir, 'use.ts'), `
import { createBrowserClient } from '@supabase/ssr';
import { createAccessNexusClient } from './client.js';
import type { Database } from './database.types.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
type Row = Database['public']['Tables']['docs']['Row'];
const client = createAccessNexusClient(createBrowserClient<Database>('http://x', 'k'));
export const a = client.auth.signInWithOAuth({ provider: 'github' });
export async function q() {
  const one = await client.docs.findOne({ slug: 'x' });
  assertType<Equal<typeof one.data, Row | null>>(true);
  const many = await client.docs.findMany({}, { columns: ['id', 'meta'] });
  assertType<Equal<typeof many.data, Pick<Row, 'id' | 'meta'>[] | null>>(true);
  const created = await client.docs.create({ owner_id: 'o', slug: 's', status: 'draft', payload: { a: 1 }, views: 0 });
  assertType<Equal<typeof created.data, Row | null>>(true);
  // @ts-expect-error unknown column name
  await client.docs.findMany({}, { columns: ['nope'] });
}
`);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);
});

describe('init wrapper files', () => {
  it('typecheck with the generated client and keep auth typed', () => {
    const dir = fixtureDir();
    write(dir, new SupabaseAdapter({ timestamps: false }).generateClient(manualSchema));
    // A Next.js project's own Supabase helpers (what `init` detects and wraps).
    writeFileSync(join(dir, 'supabase-browser.ts'), `
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types.js';
export function createClient() { return createBrowserClient<Database>('http://x', 'k'); }
`);
    writeFileSync(join(dir, 'supabase-server.ts'), `
import { createServerClient } from '@supabase/ssr';
export async function createClient() {
  return createServerClient('http://x', 'k', { cookies: { getAll: () => [], setAll: () => undefined } });
}
`);
    const at = (path: string) => ({ importPath: path, symbol: 'createClient', callable: true });
    const wrapped = generateFrameworkFiles({
      framework: 'nextjs-app', sdkOutputPath: '.',
      existing: { browser: { ...at('./supabase-browser.js'), async: false }, server: { ...at('./supabase-server.js'), async: true } },
    });
    // Fresh (non-wrapping) browser client and the plain supabase-js one.
    const fresh = generateFrameworkFiles({ framework: 'nextjs-app', sdkOutputPath: '.' }).find((f) => f.path.endsWith('browser.ts'))!;
    const single = generateFrameworkFiles({ framework: 'node', sdkOutputPath: '.' })[0];
    const envFree = (src: string) => src.replace(/process\.env\.[A-Z_]+!/g, "'x'");
    write(dir, [
      ...wrapped.map((f) => ({ path: `wrapped-${f.path.split('/').pop()}`, content: f.content })),
      { path: 'fresh-browser.ts', content: envFree(fresh.content) },
      { path: 'single.ts', content: envFree(single.content) },
    ]);
    writeFileSync(join(dir, 'use.ts'), `
import { accessnexus as wrappedBrowser } from './wrapped-browser.js';
import { createServerAccessNexus } from './wrapped-server.js';
import { accessnexus as freshBrowser } from './fresh-browser.js';
import { accessnexus as single } from './single.js';
export const a = wrappedBrowser.auth.signInWithOAuth({ provider: 'github' });
export const b = freshBrowser.auth.getSession();
export const c = single.auth.getUser();
export async function d() {
  const server = await createServerAccessNexus();
  const { data } = await server.docs.findOne({ slug: 'x' }, { columns: ['id'] });
  return [await server.auth.getUser(), data?.id];
}
`);
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);
});
