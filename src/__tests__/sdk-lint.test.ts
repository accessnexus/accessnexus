import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineSchema, table } from '../core/schema/builders.js';
import { policy } from '../core/policy/builders.js';
import { rpc } from '../core/rpc/builders.js';
import exampleSchema from '../../examples/fullstack-saas.schema.js';

// The generated SDK lands in user projects, which commonly lint with
// typescript-eslint `recommended`: it must pass it as-is (no `{}`, no `any`).

const smallSchema = defineSchema({
  profiles: table({ columns: { id: 'uuid', name: 'text' }, primaryKey: 'id', policies: { select: policy.public() } }),
  notes: table({
    columns: { id: 'uuid', owner_id: 'uuid', body: 'text' },
    primaryKey: 'id',
    references: { owner_id: 'profiles.id' },
    policies: { select: policy.isOwner('owner_id') },
  }),
}, {
  rpcs: {
    ping: rpc({ returns: 'text', language: 'sql', body: `SELECT 'pong'` }),
    add: rpc({ args: { a: 'int', b: 'int' }, returns: 'int', language: 'sql', body: 'SELECT a + b' }),
  },
});

function writeSdk(schema: Parameters<SupabaseAdapter['generateClient']>[0]): string {
  const dir = mkdtempSync(join(tmpdir(), 'accessnexus-sdk-'));
  for (const file of new SupabaseAdapter({ timestamps: false }).generateClient(schema)) {
    writeFileSync(join(dir, file.path), file.content);
  }
  return dir;
}

async function lint(dir: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: dir,
    overrideConfigFile: true,
    overrideConfig: tseslint.config(...tseslint.configs.recommended) as any,
  });
  const results = await eslint.lintFiles(['client.ts', 'types.ts']);
  return results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.ruleId}: ${m.message}`));
}

function typecheck(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true,
  });
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('generated SDK lint', () => {
  it('passes typescript-eslint recommended (example schema)', async () => {
    expect(await lint(writeSdk(exampleSchema))).toEqual([]);
  }, 60_000);

  it('passes typescript-eslint recommended and typechecks with a no-arg RPC and relations', async () => {
    const dir = writeSdk(smallSchema);
    expect(await lint(dir)).toEqual([]);
    const types = (await import('node:fs')).readFileSync(join(dir, 'types.ts'), 'utf-8');
    expect(types).toContain('Args: Record<string, never>;');
    writeFileSync(join(dir, 'use.ts'), [
      `import { createAccessNexusClient } from './client.js';`,
      `declare const supabase: { auth: unknown; from(table: string): unknown; rpc(name: string, args?: object): unknown };`,
      `const client = createAccessNexusClient(supabase);`,
      `export const a = client.rpc.ping();`,
      `export const b = client.rpc.add({ a: 1, b: 2 });`,
      `export const c = client.notes.findMany(undefined, { include: { owner: true } });`,
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    expect(typecheck([join(dir, 'use.ts')])).toEqual([]);
  }, 60_000);
});
