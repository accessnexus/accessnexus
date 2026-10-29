// `accessnexus init` writes a marked block into AGENTS.md so coding agents learn the
// AccessNexus workflow. It must be idempotent and never touch text outside the markers.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  CLAUDE_POINTER,
  ensureClaudePointer,
  renderAgentsBlock,
  upsertAgentsBlock,
  writeAgentInstructions,
} from '../cli/init/agents.js';
import { clientImportHints } from '../cli/init/index.js';

const OPTIONS = { schemaPath: 'accessnexus.schema.ts', sdkPath: 'src/lib/accessnexus', generatedDir: 'generated' };
const BLOCK = renderAgentsBlock(OPTIONS);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accessnexus-agents-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('renderAgentsBlock', () => {
  it('is wrapped in markers and states the rules and the llms.txt path', () => {
    expect(BLOCK.startsWith(AGENTS_BLOCK_START)).toBe(true);
    expect(BLOCK.endsWith(AGENTS_BLOCK_END)).toBe(true);
    expect(BLOCK).toContain('node_modules/accessnexus/llms.txt');
    expect(BLOCK).toContain('single source of truth');
    expect(BLOCK).toContain('npx accessnexus validate --json');
    expect(BLOCK).toContain('push --dry-run');
    expect(BLOCK).toContain('src/lib/accessnexus/client.ts');
    expect(BLOCK).toContain('(SELECT auth.uid())');
    // diff is useful only before generate (it compares schema vs files on disk).
    expect(BLOCK.indexOf('accessnexus diff --json')).toBeLessThan(BLOCK.indexOf('accessnexus generate --json'));
    // The wrapper init writes is the user's to edit.
    expect(BLOCK).toContain('are yours');
  });
});

describe('upsertAgentsBlock', () => {
  it('creates a new AGENTS.md when absent or empty', () => {
    expect(upsertAgentsBlock(undefined, BLOCK)).toBe(`# AGENTS.md\n\n${BLOCK}\n`);
    expect(upsertAgentsBlock('  \n', BLOCK)).toBe(`# AGENTS.md\n\n${BLOCK}\n`);
  });

  it('appends to an existing file without touching its content', () => {
    const existing = '# Project rules\n\nUse tabs.\n';
    const next = upsertAgentsBlock(existing, BLOCK);
    expect(next).toBe(`${existing}\n${BLOCK}\n`);
    expect(upsertAgentsBlock('no newline', BLOCK)).toBe(`no newline\n\n${BLOCK}\n`);
  });

  it('replaces an existing block in place and keeps text before and after', () => {
    const existing = `# Rules\n\n${AGENTS_BLOCK_START}\nold stuff\n${AGENTS_BLOCK_END}\n\n## After\nkeep me\n`;
    const next = upsertAgentsBlock(existing, BLOCK);
    expect(next).toBe(`# Rules\n\n${BLOCK}\n\n## After\nkeep me\n`);
    expect(next).not.toContain('old stuff');
  });

  it('is idempotent', () => {
    const once = upsertAgentsBlock('# Rules\n', BLOCK);
    expect(upsertAgentsBlock(once, BLOCK)).toBe(once);
    expect(once.split(AGENTS_BLOCK_START)).toHaveLength(2);
  });
});

describe('ensureClaudePointer', () => {
  it('adds the pointer once', () => {
    const once = ensureClaudePointer('# Claude\n');
    expect(once).toBe(`# Claude\n\n${CLAUDE_POINTER}\n`);
    expect(ensureClaudePointer(once)).toBe(once);
    expect(CLAUDE_POINTER).toContain('@AGENTS.md');
  });
});

describe('writeAgentInstructions', () => {
  it('creates AGENTS.md and leaves a missing CLAUDE.md alone', () => {
    const root = tempDir();
    expect(writeAgentInstructions(root, OPTIONS)).toEqual({ agentsMd: 'created', claudeMd: 'absent' });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain(AGENTS_BLOCK_START);
    expect(() => readFileSync(join(root, 'CLAUDE.md'))).toThrow();
  });

  it('updates existing files once, then reports unchanged', () => {
    const root = tempDir();
    writeFileSync(join(root, 'AGENTS.md'), '# Team rules\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude rules\n');

    expect(writeAgentInstructions(root, OPTIONS)).toEqual({ agentsMd: 'updated', claudeMd: 'updated' });
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf-8');
    const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
    expect(agents.startsWith('# Team rules\n')).toBe(true);
    expect(claude).toContain(CLAUDE_POINTER);

    expect(writeAgentInstructions(root, OPTIONS)).toEqual({ agentsMd: 'unchanged', claudeMd: 'unchanged' });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toBe(agents);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toBe(claude);
  });
});

describe('clientImportHints', () => {
  it('prints importable specifiers, never a bare project folder', () => {
    expect(clientImportHints('node', 'lib/accessnexus')[0]).toContain("from './lib/accessnexus/index.js'");
    expect(clientImportHints('vite-react', 'src/lib/accessnexus')[0]).toContain("from './src/lib/accessnexus'");
    const next = clientImportHints('nextjs-app', 'src/lib/accessnexus').join('\n');
    expect(next).toContain("from '@/lib/accessnexus/server'");
    expect(next).toContain("from '@/lib/accessnexus/browser'");
    expect(clientImportHints('nextjs-pages', 'lib/accessnexus').join('\n')).toContain("from './lib/accessnexus/server'");
  });
});
