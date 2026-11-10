import { describe, it, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import { edgeFunction } from '../core/functions/builders.js';
import { checkSchema, summarizeSchema } from '../cli/schema-check.js';
import { runCli } from '../cli/run.js';

// Edge Functions: the Deno wrappers (_shared/accessnexus.ts, built on the real
// @supabase/server), scaffolds, supabase/config.toml, validate checks and the SDK.

const root = join(import.meta.dirname, '..', '..');
const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const SERVER_DIR = join(root, 'node_modules', '@supabase', 'server');
const SRC_INDEX = resolve(import.meta.dirname, '../index.ts').replaceAll('\\', '/');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fixtureDir(): string {
  const dir = mkdtempSync(join(cacheDir, 'accessnexus-fn-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  return dir;
}

const schema = () => defineSchema({
  notes: table({ columns: { id: 'uuid', body: 'text' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
}, {
  functions: {
    'invite-member': edgeFunction({
      auth: 'user',
      input: {
        org_id: 'uuid', email: 'text', role: "enum('admin','member')", note: 'text?',
        seats: 'int', code: 'varchar(4)', meta: 'jsonb?', tags: 'text[]?', starts_on: 'date?',
      },
      output: { invitation_id: 'uuid' },
    }),
    'stripe-webhook': edgeFunction({ auth: 'none', output: 'void' }),
    'nightly-report': edgeFunction({ auth: 'secret', input: {}, output: 'jsonb' }),
    'public-stats': edgeFunction({ auth: ['publishable', 'secret'], output: { count: 'int' } }),
  },
});

/** Write the generated Edge Function files under `dir` (as the CLI would under supabase/functions). */
function writeFunctions(dir: string, s = schema()): void {
  for (const f of new SupabaseAdapter({ timestamps: false }).generateEdgeFunctions(s)) {
    mkdirSync(join(dir, f.path, '..'), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
}

/** Typecheck Deno code with `npm:@supabase/server@1` mapped to the installed package. */
function typecheckDeno(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    baseUrl: root,
    paths: { 'npm:@supabase/server@1': [SERVER_DIR] },
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? `${d.file.fileName.split('/').slice(-2).join('/')}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ` : '';
    return where + ts.flattenDiagnosticMessageText(d.messageText, '\n');
  });
}

describe('generated Edge Function wrappers', () => {
  it('is not generated without functions', () => {
    const plain = defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) });
    expect(new SupabaseAdapter().generateEdgeFunctions(plain)).toEqual([]);
    expect(new SupabaseAdapter().edgeFunctionsConfigToml(plain)).toBeNull();
  });

  it('writes the shared wrappers (derived) and one scaffold per function (overwrite: false)', () => {
    const files = new SupabaseAdapter().generateEdgeFunctions(schema());
    expect(files.map((f) => [f.path, f.overwrite])).toEqual([
      ['_shared/accessnexus.ts', undefined],
      ['invite-member/index.ts', false],
      ['stripe-webhook/index.ts', false],
      ['nightly-report/index.ts', false],
      ['public-stats/index.ts', false],
    ]);
    const shared = files[0].content;
    expect(shared).toContain("import { withSupabase, type SupabaseContext } from 'npm:@supabase/server@1';");
    expect(shared).toContain("return withSupabase({ auth: 'user' }, (req, ctx) => run(req, ctx, INVITE_MEMBER_INPUT, handler));");
    expect(shared).toContain("return withSupabase({ auth: ['publishable', 'secret'] }, (req, ctx) => run(req, ctx, PUBLIC_STATS_INPUT, handler));");
    expect(shared).toContain("role: { type: 'enum', optional: false, values: ['admin', 'member'] },");
    expect(shared).toContain("code: { type: 'varchar', optional: false, maxLength: 4 },");
    expect(shared).toContain('const STRIPE_WEBHOOK_INPUT = null;');
    expect(shared).toContain('const NIGHTLY_REPORT_INPUT: Record<string, Field> = {};');
    expect(files[1].content).toContain("import { FunctionError, inviteMember } from '../_shared/accessnexus.ts';");
    expect(files[2].content).toContain('No input spec: read the body yourself');
  });

  it('lists verify_jwt per function (false only with auth none)', () => {
    expect(new SupabaseAdapter().edgeFunctionsConfigToml(schema())).toEqual([
      { name: 'invite-member', verifyJwt: true },
      { name: 'stripe-webhook', verifyJwt: false },
      { name: 'nightly-report', verifyJwt: true },
      { name: 'public-stats', verifyJwt: true },
    ]);
  });

  it('typechecks against @supabase/server, including a real implementation', () => {
    const dir = fixtureDir();
    writeFunctions(dir);
    writeFileSync(join(dir, 'invite-member', 'index.ts'), `
import { FunctionError, inviteMember } from '../_shared/accessnexus.ts';
export default {
  fetch: inviteMember(async (input, ctx) => {
    const role: 'admin' | 'member' = input.role;
    const note: string | null | undefined = input.note;
    if (!ctx.userClaims) throw new FunctionError(401, 'no_user', 'sign in');
    const { data, error } = await ctx.supabase.from('invitations').insert({ org_id: input.org_id, email: input.email, role }).select('id').single();
    if (error) throw new FunctionError(400, 'insert_failed', error.message);
    void note;
    return { invitation_id: String((data as { id: string }).id) };
  }),
};
`);
    writeFileSync(join(dir, 'wrong.ts'), `
import { publicStats, stripeWebhook } from './_shared/accessnexus.ts';
// @ts-expect-error output must be { count: number }
export const a = publicStats(async () => ({ count: 'x' }));
export const b = stripeWebhook(async (input, _ctx, req) => {
  const raw: string = await req.text();
  const nothing: undefined = input;
  void raw; void nothing;
});
`);
    const files = ['_shared/accessnexus.ts', 'invite-member/index.ts', 'stripe-webhook/index.ts', 'nightly-report/index.ts', 'public-stats/index.ts', 'wrong.ts']
      .map((f) => join(dir, f));
    expect(typecheckDeno(files)).toEqual([]);
  }, 60_000);

  it('passes typescript-eslint recommended', async () => {
    const dir = fixtureDir();
    writeFunctions(dir);
    const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: tseslint.config(...tseslint.configs.recommended) as any });
    const results = await eslint.lintFiles(['_shared/accessnexus.ts', 'invite-member/index.ts', 'stripe-webhook/index.ts']);
    expect(results.flatMap((r) => r.messages.map((m) => `${r.filePath.split('/').slice(-2).join('/')}:${m.line} ${m.ruleId}: ${m.message}`))).toEqual([]);
  }, 60_000);

  // @supabase/server requires Node >= 22 (its engines field; on Node 20 it cannot
  // create the Supabase client). The wrappers themselves run on the Edge Runtime.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  describe.skipIf(nodeMajor < 22)('at runtime with the real withSupabase', () => {
    let mod: any;
    const env = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
      for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
      const dir = fixtureDir();
      writeFunctions(dir);
      const source = readFileSync(join(dir, '_shared', 'accessnexus.ts'), 'utf-8')
        .replace("'npm:@supabase/server@1'", `'${pathToFileURL(join(SERVER_DIR, 'dist', 'index.mjs')).href}'`);
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(join(dir, 'shared.mjs'), js);
      mod = await import(pathToFileURL(join(dir, 'shared.mjs')).href);
    });
    afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    afterEach(() => { vi.restoreAllMocks(); });

    const post = (body: string, headers: Record<string, string> = {}, method = 'POST') =>
      new Request('http://x/fn', { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body });
    const secret = { apikey: 'sb_secret_test' };

    it('rejects calls without the required credential before the handler runs', async () => {
      const handler = vi.fn();
      const res = await mod.inviteMember(handler)(post('{}'));
      expect(res.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
      const nightly = await mod.nightlyReport(handler)(post('{}', { apikey: 'sb_publishable_test' }));
      expect(nightly.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it('validates the JSON body and reports every issue', async () => {
      const handler = vi.fn(async () => ({}));
      const fn = mod.nightlyReport(handler);
      expect((await fn(post('{}', secret, 'GET'))).status).toBe(405);
      const badJson = await fn(post('{nope', secret));
      expect(badJson.status).toBe(400);
      expect((await badJson.json()).error.code).toBe('invalid_json');
      const extra = await fn(post('{"x":1}', secret));
      expect(await extra.json()).toEqual({ error: { code: 'invalid_input', message: 'The request body does not match the function input', issues: [{ field: 'x', message: 'unknown field' }] } });
      expect(handler).not.toHaveBeenCalled();
      // Empty body and {} are both the empty input.
      expect((await fn(post('', secret))).status).toBe(200);
      expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ authMode: 'secret' }), expect.any(Request));
    });

    it('checks every field type', async () => {
      // Exercise the validator through a function without auth requirements of its own.
      const s = defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) }, {
        functions: { probe: edgeFunction({ auth: 'none', input: (schema() as any).__functions['invite-member'].input }) },
      });
      const dir = fixtureDir();
      writeFunctions(dir, s);
      const source = readFileSync(join(dir, '_shared', 'accessnexus.ts'), 'utf-8')
        .replace("'npm:@supabase/server@1'", `'${pathToFileURL(join(SERVER_DIR, 'dist', 'index.mjs')).href}'`);
      writeFileSync(join(dir, 'probe.mjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
      const { probe } = await import(pathToFileURL(join(dir, 'probe.mjs')).href);
      const handler = vi.fn(async (input: unknown) => input);
      const fn = probe(handler);
      const ok = {
        org_id: '6f1c2b0a-1111-4222-8333-944455556666', email: 'a@b.co', role: 'admin', seats: 3, code: 'ABCD',
        note: null, meta: { any: ['json'] }, tags: ['x'], starts_on: '2026-11-10',
      };
      const good = await fn(post(JSON.stringify(ok)));
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual(ok);

      const bad = await fn(post(JSON.stringify({
        org_id: 'not-a-uuid', role: 'owner', seats: 1.5, code: 'TOOLONG', tags: [1], starts_on: '10/11/2026',
      })));
      expect(bad.status).toBe(400);
      const { issues } = (await bad.json()).error;
      expect(issues).toEqual([
        { field: 'org_id', message: 'must be uuid' },
        { field: 'email', message: 'is required' },
        { field: 'role', message: 'must be one of: admin, member' },
        { field: 'seats', message: 'must be int' },
        { field: 'code', message: 'must be varchar' },
        { field: 'tags', message: 'must be text[]' },
        { field: 'starts_on', message: 'must be date' },
      ]);
      expect((await (await fn(post('[]'))).json()).error.issues).toEqual([{ field: '(body)', message: 'expected a JSON object' }]);
      expect((await (await fn(post(JSON.stringify({ ...ok, email: null })))).json()).error.issues).toEqual([{ field: 'email', message: 'must not be null' }]);
    });

    it('maps handler results and errors to responses, never leaking internal errors', async () => {
      const stats = (h: () => unknown) => mod.publicStats(h)(post('', { apikey: 'sb_publishable_test' }));
      const ok = await stats(async () => ({ count: 2 }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ count: 2 });
      expect(ok.headers.get('access-control-allow-origin')).toBe('*');
      const custom = await stats(async () => { throw new mod.FunctionError(409, 'taken', 'Already invited'); });
      expect(custom.status).toBe(409);
      expect(await custom.json()).toEqual({ error: { code: 'taken', message: 'Already invited' } });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const boom = await stats(async () => { throw new Error('db password is hunter2'); });
      expect(boom.status).toBe(500);
      expect(await boom.text()).not.toContain('hunter2');
      const raw = await stats(async () => new Response('teapot', { status: 418 }));
      expect(raw.status).toBe(418);
    });

    it('leaves the raw body to functions without an input spec, and answers 204 for void', async () => {
      let seen = '';
      const fn = mod.stripeWebhook(async (input: unknown, _ctx: unknown, req: Request) => {
        expect(input).toBeUndefined();
        seen = await req.text();
      });
      const res = await fn(post('{"type":"invoice.paid","raw":true}', { 'stripe-signature': 't=1' }));
      expect(res.status).toBe(204);
      expect(seen).toBe('{"type":"invoice.paid","raw":true}');
      expect((await fn(new Request('http://x/fn', { method: 'OPTIONS' }))).status).toBe(204);
    });
  });
});

describe('validate: Edge Function checks', () => {
  const codes = (s: unknown) => checkSchema(s).map((i) => `${i.severity}:${i.code}:${i.path}`);
  const tables = { notes: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }) };

  it('accepts a valid schema and lists functions in the summary', () => {
    expect(checkSchema(schema()).filter((i) => i.severity === 'error')).toEqual([]);
    expect(summarizeSchema(schema()).functions).toEqual(['invite-member', 'stripe-webhook', 'nightly-report', 'public-stats']);
    expect(codes(schema())).toContain('warning:EDGE_FUNCTION_PUBLIC:functions.stripe-webhook.auth');
  });

  it('reports bad names, options, auth modes and fields', () => {
    const found = codes(defineSchema(tables, {
      functions: {
        'Bad Name': edgeFunction(),
        _shared: edgeFunction(),
        'send-email': edgeFunction(),
        send_email: edgeFunction(),
        typo: { auth: 'user', inputs: {} } as any,
        auth_bad: edgeFunction({ auth: 'admin' as any }),
        auth_order: edgeFunction({ auth: ['none', 'user'] }),
        auth_empty: edgeFunction({ auth: [] }),
        fields: edgeFunction({ input: { Email: 'text', when: 'datetime' }, output: 'blob' }),
        not_object: edgeFunction({ input: 'text' as any }),
      },
    }));
    expect(found).toEqual(expect.arrayContaining([
      'error:INVALID_EDGE_FUNCTION:functions.Bad Name',
      'error:INVALID_EDGE_FUNCTION:functions._shared',
      'error:INVALID_EDGE_FUNCTION:functions.send_email',
      'error:INVALID_EDGE_FUNCTION:functions.typo.inputs',
      'error:INVALID_EDGE_FUNCTION:functions.auth_bad.auth',
      'error:INVALID_EDGE_FUNCTION:functions.auth_order.auth',
      'error:INVALID_EDGE_FUNCTION:functions.auth_empty.auth',
      'error:INVALID_IDENTIFIER:functions.fields.input.Email',
      'error:UNKNOWN_COLUMN_TYPE:functions.fields.input.when',
      'error:UNKNOWN_COLUMN_TYPE:functions.fields.output',
      'error:INVALID_EDGE_FUNCTION:functions.not_object.input',
    ]));
  });

  it('rejects a table that would shadow client.functions / client.channels', () => {
    const found = codes(defineSchema({ functions: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) }, { functions: {} }));
    expect(found).toContain('error:TABLE_NAME_CLASH:functions');
  });
});

describe('generated client: Edge Functions', () => {
  it('adds typed functions.* accessors that typecheck against @supabase/supabase-js', () => {
    const dir = fixtureDir();
    for (const f of new SupabaseAdapter({ timestamps: false, reactQuery: true }).generateClient(schema())) {
      writeFileSync(join(dir, f.path), f.content);
    }
    writeFileSync(join(dir, 'use.ts'), `
import { createClient } from '@supabase/supabase-js';
import { QueryClient } from '@tanstack/react-query';
import { createAccessNexusClient } from './client.js';
import { createAccessNexusQueries } from './react-query.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(value: T): T => value;
const db = createAccessNexusClient(createClient('http://x', 'k'));
export async function go() {
  const invited = await db.functions.inviteMember({ org_id: 'o', email: 'e', role: 'member', seats: 1, code: 'AB' });
  assertType<Equal<typeof invited.data, { invitation_id: string } | null>>(true);
  // @ts-expect-error role must be one of the enum values
  await db.functions.inviteMember({ org_id: 'o', email: 'e', role: 'owner', seats: 1, code: 'AB' });
  // @ts-expect-error missing required fields
  await db.functions.inviteMember({ email: 'e' });
  await db.functions.nightlyReport();
  // @ts-expect-error no input fields
  await db.functions.nightlyReport({ x: 1 });
  await db.functions.stripeWebhook({ anything: ['goes'] });
  const stats = await db.functions.publicStats(undefined, { region: 'us-east-1' });
  assertType<Equal<typeof stats.data, { count: number } | null>>(true);
}
const q = createAccessNexusQueries(db, { queryClient: new QueryClient() });
export const opts = q.functions.publicStats.query();
export const mut = q.functions.inviteMember.mutation();
`);
    const program = ts.createProgram([join(dir, 'use.ts')], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    });
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  }, 60_000);

  it('invokes with POST and the JSON body, and fails loudly without functions.invoke', async () => {
    const dir = fixtureDir();
    for (const f of new SupabaseAdapter({ timestamps: false }).generateClient(schema())) {
      if (f.path !== 'client.ts') continue;
      writeFileSync(join(dir, 'client.js'), ts.transpileModule(f.content, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
    }
    const { createAccessNexusClient } = await import(pathToFileURL(join(dir, 'client.js')).href);
    const calls: unknown[] = [];
    const db = createAccessNexusClient({
      auth: {}, from: () => ({}), rpc: () => ({}),
      functions: { invoke: async (name: string, options: unknown) => { calls.push([name, options]); return { data: { ok: true }, error: null }; } },
    });
    expect(await db.functions.inviteMember({ email: 'e' }, { headers: { 'x-a': '1' } })).toEqual({ data: { ok: true }, error: null });
    await db.functions.nightlyReport();
    expect(calls).toEqual([
      ['invite-member', { headers: { 'x-a': '1' }, body: { email: 'e' }, method: 'POST' }],
      ['nightly-report', { body: {}, method: 'POST' }],
    ]);
    const bare = createAccessNexusClient({ auth: {}, from: () => ({}), rpc: () => ({}) });
    expect(() => bare.functions.nightlyReport()).toThrow(/needs a Supabase client with Edge Functions/);
  });

  it('keeps the client unchanged without functions', () => {
    const plain = defineSchema({ notes: table({ columns: { id: 'uuid' }, primaryKey: 'id' }) });
    const client = new SupabaseAdapter({ timestamps: false }).generateClient(plain).find((f) => f.path === 'client.ts')!.content;
    expect(client).not.toMatch(/functions|invoke/);
  });
});

describe('CLI generate: Edge Functions', () => {
  let cwd: string;
  let previousCwd: string;

  async function cli(...argv: string[]): Promise<{ code: number; json: any }> {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { stdout += String(chunk); return true; }) as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli([...argv, '--json']);
    vi.restoreAllMocks();
    return { code, json: JSON.parse(stdout) };
  }

  const writeSchema = (fns: string) => writeFileSync(join(cwd, 'accessnexus.schema.ts'),
    `import { defineSchema, table, policy, edgeFunction } from '${SRC_INDEX}';
export default defineSchema({
  notes: table({ columns: { id: 'uuid' }, primaryKey: 'id', policies: { select: policy.isAuthenticated() } }),
}, { functions: { ${fns} } });`);

  beforeAll(() => {
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'accessnexus-fn-cli-'));
    process.chdir(cwd);
  });
  afterAll(() => {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('scaffolds once, keeps the user code, and manages verify_jwt in supabase/config.toml', async () => {
    mkdirSync(join(cwd, 'supabase'), { recursive: true });
    writeFileSync(join(cwd, 'supabase', 'config.toml'), 'project_id = "app"\n\n[functions.legacy]\nverify_jwt = false\n');
    writeSchema(`'invite-member': edgeFunction({ input: { email: 'text' } }), 'hook': edgeFunction({ auth: 'none' }), 'legacy': edgeFunction({ auth: 'secret' })`);

    expect((await cli('generate')).code).toBe(0);
    const fnDir = join(cwd, 'supabase', 'functions');
    expect(existsSync(join(fnDir, '_shared', 'accessnexus.ts'))).toBe(true);
    const scaffold = join(fnDir, 'invite-member', 'index.ts');
    expect(readFileSync(scaffold, 'utf-8')).toContain('not_implemented');
    const toml = readFileSync(join(cwd, 'supabase', 'config.toml'), 'utf-8');
    expect(toml).toBe(`project_id = "app"

[functions.legacy]
verify_jwt = false

# >>> accessnexus functions (generated — edit the schema, not this block)
[functions.invite-member]
verify_jwt = true

[functions.hook]
verify_jwt = false

# legacy: [functions.legacy] is already set above; set verify_jwt = true there.
# <<< accessnexus functions
`);

    // The user implements the function: generate never touches it again, diff stays clean.
    writeFileSync(scaffold, '// mine\n');
    expect((await cli('generate')).code).toBe(0);
    expect(readFileSync(scaffold, 'utf-8')).toBe('// mine\n');
    const diff = await cli('diff');
    expect(diff.json.summary).toEqual({ added: 0, modified: 0, removed: 0 });

    // Removing a function rewrites the block in place (the rest of the file is kept).
    writeSchema(`'invite-member': edgeFunction({ input: { email: 'text' } })`);
    expect((await cli('generate')).code).toBe(0);
    const after = readFileSync(join(cwd, 'supabase', 'config.toml'), 'utf-8');
    expect(after).toContain('[functions.legacy]\nverify_jwt = false\n');
    expect(after).toContain('# >>> accessnexus functions (generated — edit the schema, not this block)\n[functions.invite-member]\nverify_jwt = true\n# <<< accessnexus functions');
    expect(after).not.toContain('[functions.hook]');
    expect(after.match(/>>> accessnexus functions/g)).toHaveLength(1);
  }, 60_000);
});
