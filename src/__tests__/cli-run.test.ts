// The CLI contract agents rely on: `--json` prints exactly one JSON object on
// stdout, exit codes are 0 / 1 (user error) / 2 (internal), errors carry a
// stable code + hint, and nothing ever waits for stdin when it is not a TTY.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { AGENTS_BLOCK_START } from '../cli/init/agents.js';
import { dbConnectTimeoutMs } from '../cli/db-timeout.js';
import { assertRoleBypassesRls, runCli } from '../cli/run.js';

const SRC_INDEX = resolve(__dirname, '../index.ts').replaceAll('\\', '/');
const ENV_KEYS = ['ACCESSNEXUS_DB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL', 'DEBUG', 'NO_COLOR', 'FORCE_COLOR', 'ACCESSNEXUS_DB_CONNECT_TIMEOUT'];

const VALID_SCHEMA = `
import { defineSchema, table, policy, trigger } from '${SRC_INDEX}';

export default defineSchema({
  profiles: table({
    columns: { id: 'uuid', name: 'text', updated_at: 'timestamptz?' },
    primaryKey: 'id',
    references: { id: 'auth.users.id' },
    triggers: [trigger.updatedAt('updated_at')],
    policies: {
      select: policy.isAuthenticated(),
      insert: policy.isOwner('id'),
      update: policy.isOwner('id'),
      delete: policy.none(),
    },
  }),
});
`;

const INVALID_SCHEMA = `
import { defineSchema, table, policy } from '${SRC_INDEX}';

export default defineSchema({
  posts: table({
    columns: { id: 'uuid', author_id: 'uuid' },
    primaryKey: 'id',
    policies: { select: policy.isOwner('owner_id') },
  }),
});
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

let cwd: string;
let previousCwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  previousCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'accessnexus-cli-'));
  process.chdir(cwd);
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

async function run(...argv: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as any);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += `${args.join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += `${args.join(' ')}\n`;
  });
  const code = await runCli(argv);
  vi.restoreAllMocks();

  let json: any;
  if (argv.includes('--json')) {
    // The whole stdout must be exactly one JSON document.
    json = JSON.parse(stdout);
  }
  return { code, stdout, stderr, json };
}

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('global behaviour', () => {
  it('prints help with exit 0 and the version', async () => {
    const help = await run('help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Exit codes');
    expect(help.stdout).toContain('llms.txt');

    const version = await run('--version', '--json');
    expect(version.code).toBe(0);
    expect(version.json).toMatchObject({ ok: true, command: 'version' });
    expect(version.json.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints per-command help', async () => {
    const result = await run('push', '--help');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--json');
  });

  it('prints help as one JSON object with --json', async () => {
    for (const argv of [['help', '--json'], ['--help', '--json'], ['--json']]) {
      const result = await run(...argv);
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ ok: true, command: 'help', topic: null });
      expect(result.json.commands.map((c: any) => c.name)).toEqual(['init', 'generate', 'diff', 'validate', 'push', 'seed']);
      expect(result.json.exitCodes).toHaveProperty('2');
    }

    for (const argv of [['generate', '--help', '--json'], ['help', 'generate', '--json']]) {
      const result = await run(...argv);
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ ok: true, command: 'help', topic: 'generate' });
      expect(result.json.commands).toHaveLength(1);
      expect(result.json.commands[0].flags).toContainEqual(
        expect.objectContaining({ name: '--output', kind: 'string', value: '<dir>' }),
      );
      expect(result.json.commands[0].flags).toContainEqual(expect.objectContaining({ name: '--json', kind: 'boolean' }));
    }
  });

  it('rejects an unknown command with exit 1 and a suggestion', async () => {
    const result = await run('genrate', '--json');
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } });
    expect(result.json.error.hint).toContain('generate');
  });

  it('rejects an unknown flag instead of ignoring it', async () => {
    const result = await run('generate', '--shcema', 'x.ts', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('UNKNOWN_FLAG');
    expect(result.json.error.hint).toContain('--schema');
  });

  it('never mixes ANSI colors into --json output', async () => {
    process.env.FORCE_COLOR = '1';
    write('accessnexus.schema.ts', VALID_SCHEMA);
    const result = await run('validate', '--json');
    expect(result.stdout).not.toContain('\x1b[');
  });
});

describe('validate', () => {
  it('returns the schema summary as JSON', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    const result = await run('validate', '--json');
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      command: 'validate',
      mode: 'manual',
      summary: { errors: 0, warnings: 0 },
      issues: [],
    });
    expect(result.json.tables[0]).toMatchObject({ name: 'profiles', rls: true, policies: ['select', 'insert', 'update', 'delete'] });
  });

  it('loads schemas with extensionless sibling imports and enums (esbuild loader)', async () => {
    write('db/cols.ts', `export enum Kind { A = 'a' }\nexport const cols = { id: 'uuid', name: 'text' } as const;\n`);
    write('accessnexus.schema.ts', `
import { defineSchema, table, policy } from '${SRC_INDEX}';
import { cols, Kind } from './db/cols';

export default defineSchema({
  notes: table({
    columns: { ...cols },
    primaryKey: 'id',
    policies: { select: policy.custom(\`name <> '\${Kind.A}'\`) },
  }),
});
`);
    const result = await run('validate', '--json');
    expect(result.code).toBe(0);
    expect(result.json.tables[0]).toMatchObject({ name: 'notes', columns: 2 });
    expect(existsSync(join(cwd, 'db'))).toBe(true);
  });

  it('fails with exit 1 and lists each issue with path and hint', async () => {
    write('accessnexus.schema.ts', INVALID_SCHEMA);
    const result = await run('validate', '--json');
    expect(result.code).toBe(1);
    expect(result.json.ok).toBe(false);
    expect(result.json.error.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(result.json.summary).toEqual({ errors: 1, warnings: 0 });
    expect(result.json.issues[0]).toMatchObject({
      severity: 'error',
      code: 'UNKNOWN_COLUMN',
      path: 'posts.policies.select',
    });
    expect(result.json.issues[0].hint).toContain('author_id');
  });

  it('prints human errors on stderr without a stack trace', async () => {
    write('accessnexus.schema.ts', INVALID_SCHEMA);
    const result = await run('validate');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('posts.policies.select');
    expect(result.stderr).toContain('Fix:');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('reports a missing schema file with how to create it', async () => {
    const result = await run('validate', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('SCHEMA_NOT_FOUND');
    expect(result.json.error.hint).toContain('init');
  });

  it('reports builder errors thrown while loading the schema as SCHEMA_INVALID', async () => {
    write('accessnexus.schema.ts', `
import { defineSchema, table } from '${SRC_INDEX}';
export default defineSchema({ Posts: table({ columns: { id: 'uuid' } }) });
`);
    const result = await run('validate', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('SCHEMA_INVALID');
    expect(result.json.error.message).toContain('snake_case');
  });

  it('reports a schema without default export', async () => {
    write('accessnexus.schema.ts', 'export const schema = {};\n');
    const result = await run('validate', '--json');
    expect(result.json.error.code).toBe('SCHEMA_NO_DEFAULT_EXPORT');
    expect(result.json.error.hint).toContain('export default schema');
  });

  it('reads the schema path from accessnexus.config and honours --config', async () => {
    write('db/schema.ts', VALID_SCHEMA);
    write('cfg/accessnexus.config.mjs', "export default { schema: './db/schema.ts' };\n");
    const ok = await run('validate', '--config', 'cfg/accessnexus.config.mjs', '--json');
    expect(ok.code).toBe(0);
    expect(ok.json.schemaPath).toBe('./db/schema.ts');

    const missing = await run('validate', '--config', 'nope.ts', '--json');
    expect(missing.code).toBe(1);
    expect(missing.json.error.code).toBe('CONFIG_NOT_FOUND');
  });

  it('fails loudly on a config that throws instead of silently using defaults', async () => {
    write('accessnexus.config.mjs', "throw new Error('bad config');\n");
    const result = await run('validate', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('CONFIG_LOAD_FAILED');
    expect(result.json.error.message).toContain('bad config');
  });
});

describe('generate and diff', () => {
  it('generates files, then reports them unchanged on a second run', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);

    const first = await run('generate', '--json');
    expect(first.code).toBe(0);
    expect(first.json.ok).toBe(true);
    expect(first.json.summary.created).toBeGreaterThan(0);
    const paths = first.json.files.map((f: any) => f.path);
    expect(paths).toContain('generated/policies/profiles_rls.sql');
    expect(paths).toContain('generated/sdk/client.ts');
    expect(first.json.files.every((f: any) => f.status === 'created')).toBe(true);
    const policy = readFileSync(join(cwd, 'generated/policies/profiles_rls.sql'), 'utf-8');
    expect(policy).toContain('(SELECT auth.uid())');

    // Only the volatile "Generated at" header would differ — files are left untouched.
    const second = await run('generate', '--json');
    expect(second.json.summary.created).toBe(0);
    expect(second.json.summary.updated).toBe(0);
    expect(readFileSync(join(cwd, 'generated/policies/profiles_rls.sql'), 'utf-8')).toBe(policy);

    const diff = await run('diff', '--json', '--check');
    expect(diff.code).toBe(0);
    expect(diff.json).toMatchObject({ ok: true, changed: false, summary: { added: 0, modified: 0, removed: 0 } });
  });

  it('--output wins over the output folders of accessnexus.config.ts', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    write('accessnexus.config.ts', `import { defineConfig } from '${SRC_INDEX}';
export default defineConfig({ schema: './accessnexus.schema.ts', output: { sdk: './src/lib/accessnexus' } });
`);
    const result = await run('generate', '--output', 'preview', '--json');
    expect(result.code).toBe(0);
    const paths: string[] = result.json.files.map((f: any) => f.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.startsWith('preview/'))).toBe(true);
    expect(paths).toContain('preview/policies/profiles_rls.sql');
    expect(paths).toContain('preview/sdk/client.ts');
    expect(existsSync(join(cwd, 'generated'))).toBe(false);
    expect(existsSync(join(cwd, 'src/lib/accessnexus'))).toBe(false);

    // Without --output the config paths apply.
    const plain = await run('generate', '--json');
    expect(plain.json.files.map((f: any) => f.path)).toContain('src/lib/accessnexus/client.ts');
  });

  it('diff --check exits 1 with the pending changes when output is stale', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    await run('generate', '--json');
    write('v2.schema.ts', VALID_SCHEMA.replace('delete: policy.none()', "delete: policy.isOwner('id')"));

    const diff = await run('diff', '--schema', 'v2.schema.ts', '--json', '--check');
    expect(diff.code).toBe(1);
    expect(diff.json.ok).toBe(false);
    expect(diff.json.error.code).toBe('GENERATED_OUT_OF_DATE');
    expect(diff.json.changed).toBe(true);
    const policyChange = diff.json.changes.find((c: any) => c.path === 'generated/policies/profiles_rls.sql');
    expect(policyChange.status).toBe('modified');
    expect(policyChange.diff).toContain('+');
  });

  it('refuses to generate from an invalid schema and writes nothing', async () => {
    write('accessnexus.schema.ts', INVALID_SCHEMA);
    const result = await run('generate', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('SCHEMA_VALIDATION_FAILED');
    expect(existsSync(join(cwd, 'generated'))).toBe(false);
  });

  it('rejects --sql-only together with --sdk-only', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    const result = await run('generate', '--sql-only', '--sdk-only', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('INVALID_FLAGS');
  });

  it('maps unexpected failures to exit 2 and only shows the stack with --verbose', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    const boom = () => {
      throw new TypeError('kaboom');
    };

    vi.spyOn(SupabaseAdapter.prototype, 'generatePolicies').mockImplementation(boom);
    const quiet = await run('generate', '--json');
    expect(quiet.code).toBe(2);
    expect(quiet.json.error.code).toBe('INTERNAL_ERROR');
    expect(quiet.json.error.stack).toBeUndefined();

    vi.spyOn(SupabaseAdapter.prototype, 'generatePolicies').mockImplementation(boom);
    const verbose = await run('generate', '--json', '--verbose');
    expect(verbose.code).toBe(2);
    expect(verbose.json.error.stack).toContain('kaboom');
  });
});

describe('push', () => {
  it('fails with NOTHING_TO_PUSH before anything was generated', async () => {
    const result = await run('push', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('NOTHING_TO_PUSH');
    expect(result.json.error.hint).toContain('generate');
  });

  it('returns the plan on --dry-run without a database', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    await run('generate', '--json');
    const result = await run('push', '--dry-run', '--json');
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, dryRun: true, adapter: 'supabase', applied: [] });
    const policies = result.json.plan.find((p: any) => p.category === 'policies');
    expect(policies.files).toEqual(['generated/policies/profiles_rls.sql']);
  });

  it('selects a typed config target with --target', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    write('accessnexus.config.ts', `import { defineConfig } from '${SRC_INDEX}';
export default defineConfig({
  targets: { prod: { adapter: 'supabase', adapterOptions: { dbUrlEnv: 'PROD_DB_URL' } } },
});
`);
    await run('generate', '--json');
    const result = await run('push', '--target', 'prod', '--dry-run', '--json');
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, target: 'prod' });

    const missing = await run('push', '--target', 'prod', '--json');
    expect(missing.json.error.code).toBe('DB_URL_MISSING');
    expect(missing.json.error.hint).toContain('PROD_DB_URL');
  });

  it('refuses to push when generated SQL is stale', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    await run('generate', '--json');
    write('accessnexus.schema.ts', VALID_SCHEMA.replace("name: 'text'", "name: 'text', bio: 'text?'"));
    const result = await run('push', '--dry-run', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('GENERATED_OUT_OF_DATE');
  });

  it('explains where the database URL comes from when it is missing', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    await run('generate', '--json');
    const result = await run('push', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('DB_URL_MISSING');
    expect(result.json.error.hint).toContain('SUPABASE_DB_URL');
    expect(result.json.error.hint).toContain('--url');
  });

  it('refuses to push SECURITY DEFINER helpers with a role that does not bypass RLS', async () => {
    const client = (bypass: boolean) => ({ query: async () => ({ rows: [{ role: 'app_owner', bypass }] }) });
    await expect(assertRoleBypassesRls(client(true))).resolves.toBeUndefined();
    await expect(assertRoleBypassesRls(client(false))).rejects.toMatchObject({
      code: 'PUSH_ROLE_NO_BYPASSRLS',
      exitCode: 1,
      hint: expect.stringContaining('BYPASSRLS'),
    });
  });

  it('reports an unreachable database without leaking the password', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    await run('generate', '--json');
    const result = await run('push', '--url', 'postgres://user:s3cret@127.0.0.1:1/db?sslmode=disable', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('DB_CONNECTION_FAILED');
    expect(result.stdout).not.toContain('s3cret');
  });

  it('times out a database that never answers instead of hanging', async () => {
    expect(dbConnectTimeoutMs({})).toBe(10_000);
    expect(dbConnectTimeoutMs({ ACCESSNEXUS_DB_CONNECT_TIMEOUT: '2.5' })).toBe(2_500);
    expect(dbConnectTimeoutMs({ ACCESSNEXUS_DB_CONNECT_TIMEOUT: 'soon' })).toBe(10_000);

    // A server that accepts TCP and then never speaks (like a blackholed host).
    const sockets: Socket[] = [];
    const server = createServer((socket) => { sockets.push(socket); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    try {
      write('accessnexus.schema.ts', VALID_SCHEMA);
      await run('generate', '--json');
      process.env.ACCESSNEXUS_DB_CONNECT_TIMEOUT = '0.3';
      const started = Date.now();
      const result = await run('push', '--url', `postgres://u:p@127.0.0.1:${port}/db?sslmode=disable`, '--json');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.code).toBe(1);
      expect(result.json.error.code).toBe('DB_CONNECTION_FAILED');
      expect(result.json.error.hint).toContain('ACCESSNEXUS_DB_CONNECT_TIMEOUT');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('seed', () => {
  it('reports a missing seed file', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    const result = await run('seed', '--dry-run', '--json');
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('SEED_NOT_FOUND');
  });

  it('previews the seed SQL on --dry-run', async () => {
    write('accessnexus.schema.ts', VALID_SCHEMA);
    write('accessnexus.seed.mjs', "export default { profiles: [{ id: '00000000-0000-0000-0000-000000000001', name: 'Ada' }] };\n");
    const result = await run('seed', '--seed', 'accessnexus.seed.mjs', '--dry-run', '--json');
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, dryRun: true, rows: 1, applied: false });
    expect(result.json.sql).toContain('INSERT INTO');
  });
});

describe('init (non-interactive)', () => {
  function reactProject(): void {
    write('package.json', JSON.stringify({ name: 'app', dependencies: { react: '18.0.0', vite: '5.0.0', '@supabase/supabase-js': '2.0.0' } }));
    mkdirSync(join(cwd, 'src'), { recursive: true });
  }

  it('refuses to prompt when stdin is not a TTY and --yes is missing', async () => {
    reactProject();
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    try {
      const result = await run('init', '--json');
      expect(result.code).toBe(1);
      expect(result.json.error.code).toBe('INIT_NOT_INTERACTIVE');
      expect(result.json.error.hint).toContain('--yes');
      expect(existsSync(join(cwd, 'accessnexus.schema.ts'))).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  it('--yes scaffolds the project, config and AGENTS.md block without prompting', async () => {
    reactProject();
    write('CLAUDE.md', '# Claude\n');

    const result = await run('init', '--yes', '--sdk', 'src/db', '--json');
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      status: 'initialized',
      framework: 'vite-react',
      schemaSource: 'template',
      sdkPath: 'src/db',
      agents: { agentsMd: 'created', claudeMd: 'updated' },
    });
    expect(readFileSync(join(cwd, 'accessnexus.config.ts'), 'utf-8')).toContain("sdk: './src/db'");
    expect(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')).scripts.accessnexus).toBe('accessnexus generate');
    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain(AGENTS_BLOCK_START);
    expect(agents).toContain('src/db/client.ts');
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf-8')).toContain('@AGENTS.md');

    // Re-running is safe: schema kept, AGENTS.md block unchanged.
    const again = await run('init', '--yes', '--sdk', 'src/db', '--json');
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({ status: 'already_initialized', agents: { agentsMd: 'unchanged', claudeMd: 'unchanged' } });
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8')).toBe(agents);
  });

  it('--no-agents skips AGENTS.md', async () => {
    reactProject();
    const result = await run('init', '--yes', '--no-agents', '--no-introspect', '--json');
    expect(result.code).toBe(0);
    expect(result.json.agents).toBeNull();
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });

  it('--force re-initializes an existing schema', async () => {
    reactProject();
    write('accessnexus.schema.ts', '// mine\nexport default {};\n');
    const result = await run('init', '--yes', '--force', '--no-introspect', '--json');
    expect(result.code).toBe(0);
    expect(result.json.files).toContainEqual({ path: 'accessnexus.schema.ts', action: 'updated' });
    expect(readFileSync(join(cwd, 'accessnexus.schema.ts'), 'utf-8')).toContain('defineSchema');
  });

  it('--yes completes in an empty folder by creating a minimal package.json', async () => {
    const result = await run('init', '--yes', '--no-introspect', '--json');
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, status: 'initialized', framework: 'node' });
    expect(result.json.files).toContainEqual({ path: 'package.json', action: 'created' });
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
    expect(pkg).toMatchObject({ private: true, type: 'module', scripts: { accessnexus: 'accessnexus generate' } });
    // A real import specifier, not a bare folder name.
    expect(result.json.nextSteps.join('\n')).toContain("from './lib/accessnexus/index.js'");
  });

  it('explains how to create a project when there is no package.json (interactive)', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const result = await run('init');
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain('INIT_DETECT_FAILED');
      expect(result.stdout + result.stderr).toContain('npm init -y');
      expect(existsSync(join(cwd, 'package.json'))).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  it('writes a client wrapper marked as editable (generate never touches it)', async () => {
    reactProject();
    const result = await run('init', '--yes', '--no-introspect', '--sdk', 'src/db', '--json');
    expect(result.code).toBe(0);
    const wrapper = readFileSync(join(cwd, 'src/db/index.ts'), 'utf-8');
    expect(wrapper).not.toContain('DO NOT EDIT');
    expect(wrapper).toContain('Yours to edit');
    expect(result.json.nextSteps.join('\n')).toContain("from './src/db'");
  });
});
