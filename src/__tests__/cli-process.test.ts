// End-to-end: run the real `accessnexus` entry point in a child process with a
// piped (non-TTY) stdin, the way coding agents and CI invoke it. Guards against
// any prompt that would block forever waiting for input.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const VITE_NODE = join(ROOT, 'node_modules/vite-node/vite-node.mjs');
const ENTRY = join(ROOT, 'src/cli/index.ts');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accessnexus-proc-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '18.0.0', vite: '5.0.0' } }));
  mkdirSync(join(dir, 'src'));
  return dir;
}

function cli(cwd: string, args: string[]) {
  const env = { ...process.env };
  for (const key of ['ACCESSNEXUS_DB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL', 'FORCE_COLOR']) delete env[key];
  return spawnSync(process.execPath, [VITE_NODE, ENTRY, ...args], {
    cwd,
    env,
    input: '', // piped stdin, immediately closed: never a TTY
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('accessnexus as a child process (non-TTY stdin)', () => {
  it('init without --yes exits 1 with a clear error instead of hanging', () => {
    const result = cli(project(), ['init']);
    expect(result.error).toBeUndefined(); // not killed by the timeout
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INIT_NOT_INTERACTIVE');
    expect(result.stderr).toContain('--yes');
  }, 40_000);

  it('init --yes --json completes and prints a single JSON object', () => {
    const result = cli(project(), ['init', '--yes', '--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({ ok: true, command: 'init', status: 'initialized', agents: { agentsMd: 'created' } });
  }, 40_000);

  it('a missing schema exits 1 with JSON on stdout and no stack trace', () => {
    const result = cli(project(), ['validate', '--json']);
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.error.code).toBe('SCHEMA_NOT_FOUND');
    expect(result.stdout + result.stderr).not.toMatch(/\n\s+at /);
  }, 40_000);
});
