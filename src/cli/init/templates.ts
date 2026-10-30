// ============================================
// AccessNexus - Framework-Specific Templates
// Generates client wrapper files per framework
// ============================================

import type { Framework } from './detect.js';

export interface TemplateFile {
  path: string;
  content: string;
}

/** An existing project client, resolved to an import specifier relative to the SDK dir. */
export interface ResolvedExisting {
  importPath: string; // e.g. '../supabase/client'
  symbol: string; // e.g. 'createClient' or 'supabase'
  callable: boolean;
  async: boolean;
}

export interface TemplateOptions {
  framework: Framework;
  sdkOutputPath: string;
  /** When present, wrap these instead of instantiating a new Supabase client. */
  existing?: { browser?: ResolvedExisting; server?: ResolvedExisting };
  /**
   * How the wrappers import the generated client: `'bundler'` → `./client` (Next.js,
   * Vite and other bundlers resolve extensionless TS imports, but Turbopack cannot
   * map `./client.js` to `client.ts`); `'node'` → `./client.js` (NodeNext ESM).
   * Defaults to `'bundler'` for every framework except plain Node.
   */
  moduleResolution?: 'bundler' | 'node';
}

/** `true` when wrappers should import `./client` without an extension. */
export function usesExtensionlessImports(framework: Framework, tsconfigModuleResolution?: string): boolean {
  if (framework !== 'node') return true;
  return (tsconfigModuleResolution ?? '').toLowerCase() === 'bundler';
}

export function generateFrameworkFiles(options: TemplateOptions): TemplateFile[] {
  const resolution = options.moduleResolution ?? (options.framework === 'node' ? 'node' : 'bundler');
  const files = frameworkFiles(options);
  if (resolution === 'node') return files;
  return files.map((file) => ({
    ...file,
    content: file.content.replaceAll("from './client.js'", "from './client'"),
  }));
}

function frameworkFiles(options: TemplateOptions): TemplateFile[] {
  const { framework, sdkOutputPath, existing } = options;

  switch (framework) {
    case 'nextjs-app':
      return generateNextAppRouterFiles(sdkOutputPath, existing);
    case 'nextjs-pages':
      return generateNextPagesFiles(sdkOutputPath, existing);
    case 'vite-react':
      return generateSingleClientFiles(sdkOutputPath, 'vite', existing);
    case 'cra':
      return generateSingleClientFiles(sdkOutputPath, 'cra', existing);
    case 'react-other':
    case 'node':
      return generateSingleClientFiles(sdkOutputPath, 'generic', existing);
    case 'vite':
      return generateSingleClientFiles(sdkOutputPath, 'vite', existing);
  }
}

// ---- Shared helpers ----

/**
 * Header of the wrapper files init writes. They are the user's code: `generate`
 * never touches them (only client.ts / types.ts in the same folder are derived).
 */
export const WRAPPER_HEADER =
  '// Created by `accessnexus init`. Yours to edit (env var names, client options);\n'
  + '// `accessnexus generate` never overwrites it. Generated (do not edit): client.ts, types.ts.';

/** `createClient()` / `await createClient()` / `supabase`, depending on the export. */
function acquire(existing: ResolvedExisting): string {
  if (!existing.callable) return existing.symbol;
  return `${existing.async ? 'await ' : ''}${existing.symbol}()`;
}

function wrappedServerFile(existing: ResolvedExisting): string {
  return `${WRAPPER_HEADER}
// Wraps the project's existing Supabase server client (no duplicate client).
import { ${existing.symbol} } from '${existing.importPath}';
import { createAccessNexusClient } from './client.js';

export async function createServerAccessNexus() {
  const supabase = ${acquire(existing)};
  return createAccessNexusClient(supabase);
}
`;
}

function wrappedBrowserFile(existing: ResolvedExisting, useClientDirective: boolean): string {
  return `${WRAPPER_HEADER}
// Wraps the project's existing Supabase browser client (no duplicate client).
${useClientDirective ? "'use client';\n\n" : ''}import { ${existing.symbol} } from '${existing.importPath}';
import { createAccessNexusClient } from './client.js';

export const accessnexus = createAccessNexusClient(${acquire(existing)});
`;
}

// ---- Next.js App Router ----

function generateNextAppRouterFiles(
  sdkPath: string,
  existing?: TemplateOptions['existing'],
): TemplateFile[] {
  return [
    {
      path: `${sdkPath}/server.ts`,
      content: existing?.server
        ? wrappedServerFile(existing.server)
        : `${WRAPPER_HEADER}
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createAccessNexusClient } from './client.js';

export async function createServerAccessNexus() {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Ignore — called from Server Component
          }
        },
      },
    },
  );

  return createAccessNexusClient(supabase);
}
`,
    },
    {
      path: `${sdkPath}/browser.ts`,
      content: existing?.browser
        ? wrappedBrowserFile(existing.browser, true)
        : `${WRAPPER_HEADER}
'use client';

import { createBrowserClient } from '@supabase/ssr';
import { createAccessNexusClient } from './client.js';

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export const accessnexus = createAccessNexusClient(supabase);
`,
    },
  ];
}

// ---- Next.js Pages Router ----

function generateNextPagesFiles(
  sdkPath: string,
  existing?: TemplateOptions['existing'],
): TemplateFile[] {
  return [
    {
      path: `${sdkPath}/server.ts`,
      content: existing?.server
        ? wrappedServerFile(existing.server)
        : `${WRAPPER_HEADER}
import { createServerClient } from '@supabase/ssr';
import type { GetServerSidePropsContext } from 'next';
import { createAccessNexusClient } from './client.js';

export function createServerAccessNexus(context: GetServerSidePropsContext) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          const cookies = context.req.cookies;
          return Object.entries(cookies).map(([name, value]) => ({
            name,
            value: value ?? '',
          }));
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            context.res.setHeader(
              'Set-Cookie',
              \`\${name}=\${value}; Path=\${options?.path ?? '/'}; HttpOnly; SameSite=Lax\`,
            );
          });
        },
      },
    },
  );

  return createAccessNexusClient(supabase);
}
`,
    },
    {
      path: `${sdkPath}/browser.ts`,
      content: existing?.browser
        ? wrappedBrowserFile(existing.browser, false)
        : `${WRAPPER_HEADER}
import { createBrowserClient } from '@supabase/ssr';
import { createAccessNexusClient } from './client.js';

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export const accessnexus = createAccessNexusClient(supabase);
`,
    },
  ];
}

// ---- Vite / CRA / Generic React (single client file) ----

function generateSingleClientFiles(
  sdkPath: string,
  kind: 'vite' | 'cra' | 'generic',
  existing?: TemplateOptions['existing'],
): TemplateFile[] {
  if (existing?.browser) {
    return [
      { path: `${sdkPath}/index.ts`, content: wrappedBrowserFile(existing.browser, false) },
    ];
  }

  const env =
    kind === 'vite'
      ? {
          url: 'import.meta.env.VITE_SUPABASE_URL',
          key: 'import.meta.env.VITE_SUPABASE_ANON_KEY',
          note: '',
        }
      : kind === 'cra'
        ? {
            url: 'process.env.REACT_APP_SUPABASE_URL!',
            key: 'process.env.REACT_APP_SUPABASE_ANON_KEY!',
            note: '',
          }
        : {
            url: 'process.env.SUPABASE_URL!',
            key: 'process.env.SUPABASE_ANON_KEY!',
            note: '// Update these to match your environment variable setup\n',
          };

  return [
    {
      path: `${sdkPath}/index.ts`,
      content: `${WRAPPER_HEADER}
import { createClient } from '@supabase/supabase-js';
import { createAccessNexusClient } from './client.js';

${env.note}const supabase = createClient(
  ${env.url},
  ${env.key},
);

export const accessnexus = createAccessNexusClient(supabase);
`,
    },
  ];
}
