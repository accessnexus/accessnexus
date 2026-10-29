// ============================================
// AccessNexus - Framework & Supabase Detection
// Detects project setup from package.json and filesystem
// ============================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Framework =
  | 'nextjs-app'
  | 'nextjs-pages'
  | 'vite-react'
  | 'cra'
  | 'react-other'
  | 'vite'
  | 'node';

export interface EnvVars {
  url?: string;
  anonKey?: string;
  serviceRoleKey?: string;
  urlVarName: string;
  anonKeyVarName: string;
}

export interface ExistingClientExport {
  /** Path relative to projectRoot, POSIX separators, no extension. */
  file: string;
  /** Exported symbol to import (e.g. `createClient`) or the instance name. */
  symbol: string;
  /** true when the export is a factory function that must be called. */
  callable: boolean;
  /** true when calling the factory returns a promise (server clients). */
  async: boolean;
  side: 'browser' | 'server';
}

export interface ExistingSupabase {
  browser?: ExistingClientExport;
  server?: ExistingClientExport;
}

export interface DetectionResult {
  framework: Framework;
  frameworkLabel: string;
  hasSupabase: boolean;
  supabaseVersion?: string;
  hasSupabaseSsr: boolean;
  srcDir: string;
  envVars: EnvVars;
  /** An existing Supabase client already in the project, to be wrapped instead of duplicated. */
  existingClient?: ExistingSupabase;
  packageJson: Record<string, any>;
  projectRoot: string;
}

const FRAMEWORK_LABELS: Record<Framework, string> = {
  'nextjs-app': 'Next.js (App Router)',
  'nextjs-pages': 'Next.js (Pages Router)',
  'vite-react': 'Vite + React',
  'cra': 'Create React App',
  'react-other': 'React',
  'vite': 'Vite (Vue, Svelte, Solid, ...)',
  'node': 'Node.js / other (no frontend framework detected)',
};

export function detectFramework(projectRoot: string): DetectionResult {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error('No package.json found. Run this command in a project root.');
  }

  const packageJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const deps: Record<string, string> = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Detect framework
  let framework: Framework;

  if (deps['next']) {
    const hasAppDir = existsSync(join(projectRoot, 'app')) ||
      existsSync(join(projectRoot, 'src', 'app'));
    framework = hasAppDir ? 'nextjs-app' : 'nextjs-pages';
  } else if (deps['react'] && deps['vite']) {
    framework = 'vite-react';
  } else if (deps['react'] && deps['react-scripts']) {
    framework = 'cra';
  } else if (deps['react']) {
    framework = 'react-other';
  } else if (deps['vite']) {
    framework = 'vite';
  } else {
    // Backends, scripts, Expo, SvelteKit without Vite in deps, empty projects:
    // AccessNexus is a schema/RLS tool first — scaffold a plain client wrapper.
    framework = 'node';
  }

  // Detect src directory
  const srcDir = existsSync(join(projectRoot, 'src')) ? 'src' : '.';

  // Detect Supabase
  const hasSupabase = '@supabase/supabase-js' in deps;
  const supabaseVersion = deps['@supabase/supabase-js'];
  const hasSupabaseSsr = '@supabase/ssr' in deps;

  // Parse env files
  const envVars = parseEnvVars(projectRoot, framework);

  // Detect an existing Supabase client so we wrap it instead of creating a duplicate
  const existingClient = detectExistingClient(projectRoot, srcDir);

  return {
    framework,
    frameworkLabel: FRAMEWORK_LABELS[framework],
    hasSupabase,
    supabaseVersion,
    hasSupabaseSsr,
    srcDir,
    envVars,
    existingClient,
    packageJson,
    projectRoot,
  };
}

/**
 * Scan the project for an already-present Supabase client so AccessNexus can wrap it
 * (`createAccessNexusClient(existing)`) instead of instantiating a second client.
 * Covers the standard Supabase conventions: `lib/supabase/{client,server}.ts`,
 * `utils/supabase/{client,server}.ts`, and single-file `lib/supabase(Client).ts`.
 */
export function detectExistingClient(
  projectRoot: string,
  srcDir: string,
): ExistingSupabase | undefined {
  const bases = [srcDir, '.'].filter((v, i, a) => a.indexOf(v) === i);

  // side, then candidate relative paths (without extension), most conventional first
  const candidates: Array<{ side: 'browser' | 'server'; paths: string[] }> = [
    {
      side: 'server',
      paths: ['lib/supabase/server', 'utils/supabase/server', 'lib/supabase-server'],
    },
    {
      side: 'browser',
      paths: [
        'lib/supabase/client',
        'utils/supabase/client',
        'lib/supabase/browser',
        'lib/supabaseClient',
        'lib/supabase',
        'supabaseClient',
      ],
    },
  ];

  const result: ExistingSupabase = {};
  const exts = ['.ts', '.tsx', '.js', '.jsx'];

  for (const { side, paths } of candidates) {
    if (result[side]) continue;
    for (const base of bases) {
      for (const rel of paths) {
        for (const ext of exts) {
          const abs = join(projectRoot, base, `${rel}.${ext.slice(1)}`);
          if (!existsSync(abs)) continue;
          const parsed = parseClientExport(readFileSync(abs, 'utf-8'));
          if (!parsed) continue;
          const file = `${base === '.' ? '' : `${base}/`}${rel}`;
          result[side] = { file, side, ...parsed };
          break;
        }
        if (result[side]) break;
      }
      if (result[side]) break;
    }
  }

  return result.browser || result.server ? result : undefined;
}

/** Find the client export in a Supabase client file. Prefers a `createClient` factory. */
function parseClientExport(
  src: string,
): { symbol: string; callable: boolean; async: boolean } | null {
  // export [async] function createClient(...) / createBrowserClient / createServerClient
  const fn = src.match(
    /export\s+(async\s+)?function\s+(createClient|createBrowserClient|createServerClient|createSupabase\w*)\b/,
  );
  if (fn) return { symbol: fn[2], callable: true, async: Boolean(fn[1]) };

  // export const createClient = async (...) => ...
  const arrow = src.match(
    /export\s+const\s+(createClient|createBrowserClient|createServerClient|createSupabase\w*)\s*=\s*(async\s*)?\(/,
  );
  if (arrow) return { symbol: arrow[1], callable: true, async: Boolean(arrow[2]) };

  // export const supabase = createBrowserClient(...)  → a ready instance
  const instance = src.match(/export\s+const\s+(supabase|client|db)\b/);
  if (instance) return { symbol: instance[1], callable: false, async: false };

  return null;
}

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// ---- Internal helpers ----

function parseEnvVars(projectRoot: string, framework: Framework): EnvVars {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.development.local'];
  const allVars: Record<string, string> = {};

  for (const file of envFiles) {
    const parsed = parseEnvFile(join(projectRoot, file));
    Object.assign(allVars, parsed);
  }

  // Determine which var names to look for based on framework
  const urlCandidates = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'VITE_SUPABASE_URL',
    'REACT_APP_SUPABASE_URL',
    'SUPABASE_URL',
  ];
  const anonKeyCandidates = [
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'VITE_SUPABASE_ANON_KEY',
    'REACT_APP_SUPABASE_ANON_KEY',
    'SUPABASE_ANON_KEY',
  ];

  let url: string | undefined;
  let urlVarName = '';
  for (const candidate of urlCandidates) {
    if (allVars[candidate]) {
      url = allVars[candidate];
      urlVarName = candidate;
      break;
    }
  }

  let anonKey: string | undefined;
  let anonKeyVarName = '';
  for (const candidate of anonKeyCandidates) {
    if (allVars[candidate]) {
      anonKey = allVars[candidate];
      anonKeyVarName = candidate;
      break;
    }
  }

  const serviceRoleKey = resolveServiceRoleKey(allVars);

  return { url, anonKey, serviceRoleKey, urlVarName, anonKeyVarName };
}

/**
 * Find a key usable for introspection. Prefers the new `sb_secret_…` secret key
 * (always valid) over legacy service_role JWTs, which many projects have disabled.
 * Recognizes common var names, with or without the `_KEY` suffix.
 */
function resolveServiceRoleKey(allVars: Record<string, string>): string | undefined {
  // 1. Any new-format secret key, whatever the var is named.
  for (const value of Object.values(allVars)) {
    if (typeof value === 'string' && value.startsWith('sb_secret_')) return value;
  }
  // 2. Known legacy var names.
  const candidates = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_ROLE',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_KEY',
    'SERVICE_ROLE_KEY',
  ];
  for (const name of candidates) {
    if (allVars[name]) return allVars[name];
  }
  return undefined;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  const content = readFileSync(filePath, 'utf-8');
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}
