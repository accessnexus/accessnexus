// Tests for existing-Supabase-client detection in `accessnexus init`.
// Guards against regenerating a duplicate client when the project already has one.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectExistingClient, detectFramework } from '../cli/init/detect.js';
import { generateFrameworkFiles } from '../cli/init/templates.js';

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'accessnexus-init-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('detectExistingClient', () => {
  it('detects the Next.js SSR client/server convention (createClient)', () => {
    const root = project({
      'src/lib/supabase/client.ts': `
        import { createBrowserClient } from '@supabase/ssr';
        export const supabase = createBrowserClient(url, key);
        export function createClient() { return supabase; }
      `,
      'src/lib/supabase/server.ts': `
        import { createServerClient } from '@supabase/ssr';
        export async function createClient() { return createServerClient(url, key, {}); }
      `,
    });

    const found = detectExistingClient(root, 'src');
    expect(found?.browser).toEqual({
      file: 'src/lib/supabase/client',
      side: 'browser',
      symbol: 'createClient',
      callable: true,
      async: false,
    });
    expect(found?.server).toEqual({
      file: 'src/lib/supabase/server',
      side: 'server',
      symbol: 'createClient',
      callable: true,
      async: true,
    });
  });

  it('detects a single-file instance export (vite convention)', () => {
    const root = project({
      'src/lib/supabase.ts': `
        import { createClient } from '@supabase/supabase-js';
        export const supabase = createClient(url, key);
      `,
    });

    const found = detectExistingClient(root, 'src');
    expect(found?.browser).toMatchObject({
      file: 'src/lib/supabase',
      symbol: 'supabase',
      callable: false,
    });
    expect(found?.server).toBeUndefined();
  });

  it('detects the supabase docs utils/ convention', () => {
    const root = project({
      'src/utils/supabase/client.ts': `export function createClient() { return {}; }`,
    });
    const found = detectExistingClient(root, 'src');
    expect(found?.browser?.file).toBe('src/utils/supabase/client');
  });

  it('returns undefined when no client exists', () => {
    const root = project({ 'src/index.ts': `export const x = 1;` });
    expect(detectExistingClient(root, 'src')).toBeUndefined();
  });
});

describe('detectFramework', () => {
  it('falls back to a plain Node client for projects without React', () => {
    const root = project({ 'package.json': JSON.stringify({ name: 'api', dependencies: { '@supabase/supabase-js': '2.0.0' } }) });
    const detection = detectFramework(root);
    expect(detection.framework).toBe('node');
    const [file] = generateFrameworkFiles({ framework: detection.framework, sdkOutputPath: 'lib/accessnexus' });
    expect(file.path).toBe('lib/accessnexus/index.ts');
    expect(file.content).toContain('process.env.SUPABASE_URL');
  });

  it('uses import.meta.env for non-React Vite apps (Vue, Svelte, ...)', () => {
    const root = project({ 'package.json': JSON.stringify({ name: 'web', devDependencies: { vite: '5.0.0', vue: '3.0.0' } }) });
    const detection = detectFramework(root);
    expect(detection.framework).toBe('vite');
    const [file] = generateFrameworkFiles({ framework: detection.framework, sdkOutputPath: 'src/lib/accessnexus' });
    expect(file.content).toContain('import.meta.env.VITE_SUPABASE_URL');
  });
});
