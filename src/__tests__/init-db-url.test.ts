// `init --db-url` without the optional `pg` driver must say "install pg",
// not "check the URL".
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cli/init/introspect-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/init/introspect-db.js')>();
  return {
    ...actual,
    introspectViaDb: async () => {
      throw new actual.PgDriverMissingError(new Error("Cannot find package 'pg'"));
    },
  };
});

const { runCli } = await import('../cli/run.js');

let cwd: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'accessnexus-init-db-'));
  process.chdir(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('init --db-url without pg', () => {
  it('reports PG_DRIVER_MISSING with the npm install -D pg hint', async () => {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as any);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runCli(['init', '--yes', '--no-agents', '--db-url', 'postgres://u:p@127.0.0.1:1/db', '--json']);
    vi.restoreAllMocks();
    expect(code).toBe(1);
    const json = JSON.parse(stdout);
    expect(json.error.code).toBe('PG_DRIVER_MISSING');
    expect(json.error.hint).toContain('npm install -D pg');
  });
});
