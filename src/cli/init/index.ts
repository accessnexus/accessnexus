// ============================================
// AccessNexus - Init Command
// Sets up AccessNexus in an existing project.
// Interactive in a terminal; fully non-interactive with --yes (for CI and
// coding agents). Never blocks on stdin when it is not a TTY.
// ============================================

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { SupabaseAdapter } from '../../adapters/supabase/adapter.js';
import { CliError, isJsonMode, log } from '../output.js';
import { writeAgentInstructions } from './agents.js';
import { detectFramework, detectPackageManager, type DetectionResult } from './detect.js';
import { introspectDatabase, type IntrospectedTable } from './introspect.js';
import { introspectViaDb, PgDriverMissingError, type IntrospectedFunction } from './introspect-db.js';
import { c, confirm, error, header, info, prompt, promptSecret, setInteractive, success } from './prompts.js';
import {
  buildRuntimeSchema,
  generateSchemaFromIntrospection,
  generateSchemaTemplate,
} from './schema-gen.js';
import { generateFrameworkFiles, type ResolvedExisting } from './templates.js';
import type { ExistingSupabase } from './detect.js';

export interface InitOptions {
  /** Non-interactive: accept defaults, never prompt. */
  yes: boolean;
  /** Source folder (default: detected). */
  src?: string;
  /** SDK output folder (default: `<src>/lib/accessnexus`). */
  sdk?: string;
  /** Policy name prefix (default: `accessnexus`). */
  prefix?: string;
  /** Postgres URL used to import tables, policies and functions. */
  dbUrl?: string;
  /** Try to import the existing database (default: true). */
  introspect: boolean;
  /** With --yes: install missing @supabase/* packages. */
  install: boolean;
  /** With --yes: overwrite an existing accessnexus.schema.ts. */
  force: boolean;
  /** Write the AccessNexus block into AGENTS.md / CLAUDE.md (default: true). */
  agents: boolean;
}

type FileRecord = { path: string; action: 'created' | 'updated' | 'skipped' };

const CONFIG_FILES = ['accessnexus.config.ts', 'accessnexus.config.js', 'accessnexus.config.mjs'];

function normalizeDir(dir: string): string {
  const trimmed = dir.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '.' : trimmed;
}

function defaultSdkPath(srcDir: string): string {
  return srcDir === '.' ? 'lib/accessnexus' : `${srcDir}/lib/accessnexus`;
}

export async function runInit(options: InitOptions): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const interactive = !options.yes && Boolean(process.stdin.isTTY) && !isJsonMode();

  if (!options.yes && !interactive) {
    throw new CliError('INIT_NOT_INTERACTIVE', 'init asks questions, but there is no terminal to answer them (stdin is not a TTY)', {
      hint: 'Re-run with --yes to accept the defaults, e.g. `npx accessnexus init --yes --no-introspect`. '
        + 'Optional: --sdk <dir>, --src <dir>, --prefix <name>, --db-url <url>, --install, --force, --no-agents.',
    });
  }
  setInteractive(interactive);

  const files: FileRecord[] = [];
  const record = (absPath: string, action: FileRecord['action']) =>
    files.push({ path: relative(projectRoot, absPath).replaceAll('\\', '/'), action });

  // ──── Step 1: Banner ────
  header();

  // ──── Step 2: Check for previous init ────
  const schemaPath = join(projectRoot, 'accessnexus.schema.ts');
  if (existsSync(schemaPath)) {
    info('accessnexus.schema.ts already exists');
    const reconfigure = interactive ? await confirm('Reconfigure project?', false) : options.force;
    if (!reconfigure) {
      // Still refresh the agent instructions — they are idempotent and cheap.
      const srcGuess = options.src ? normalizeDir(options.src) : existsSync(join(projectRoot, 'src')) ? 'src' : '.';
      const agents = options.agents
        ? writeAgentInstructions(projectRoot, {
          schemaPath: 'accessnexus.schema.ts',
          sdkPath: options.sdk ? normalizeDir(options.sdk) : defaultSdkPath(srcGuess),
          generatedDir: 'generated',
        })
        : null;
      reportAgents(agents);
      info(interactive ? 'Exiting — schema left unchanged' : 'Schema left unchanged (pass --force to re-initialize)');
      log('');
      return { status: 'already_initialized', files, agents };
    }
    log('');
  }

  // ──── Step 3: Detect framework ────
  // An empty folder under --yes: create a minimal ESM package.json so init can
  // finish without a prompt (agents often start from an empty directory).
  const pkgJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgJsonPath) && options.yes) {
    const name = basename(projectRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'app';
    writeFileSync(pkgJsonPath, JSON.stringify({ name, private: true, type: 'module' }, null, 2) + '\n', 'utf-8');
    record(pkgJsonPath, 'created');
    success('Created a minimal package.json (no project found)');
  }
  info('Detecting project...');
  let detection: DetectionResult;
  try {
    detection = detectFramework(projectRoot);
  } catch (err: any) {
    const noPackageJson = /package\.json/.test(err.message);
    throw new CliError('INIT_DETECT_FAILED', err.message, {
      hint: noPackageJson
        ? 'Run init from the project root (the folder with package.json), or create one with `npm init -y` '
          + 'and `npm install -D accessnexus` (or pass --yes to let init create a minimal package.json).'
        : 'Create accessnexus.schema.ts and accessnexus.config.ts by hand — see node_modules/accessnexus/llms.txt.',
      cause: err,
    });
  }
  success(`Framework: ${c.bold(detection.frameworkLabel)}`);

  // ──── Step 4: Check Supabase ────
  const pm = detectPackageManager(projectRoot);
  const installCmd = pm === 'npm' ? 'npm install' : `${pm} add`;
  const installed: string[] = [];
  const install = (pkg: string) => {
    info(`Installing ${pkg} with ${pm}...`);
    try {
      execSync(`${installCmd} ${pkg}`, {
        cwd: projectRoot,
        stdio: isJsonMode() ? ['ignore', 'ignore', 'inherit'] : 'inherit',
      });
      installed.push(pkg);
      success(`${pkg} installed`);
    } catch {
      error(`Installation failed — run \`${installCmd} ${pkg}\` manually`);
    }
  };

  if (!detection.hasSupabase) {
    error('@supabase/supabase-js not found');
    const doInstall = interactive ? await confirm('Install it now?', true) : options.install;
    if (doInstall) install('@supabase/supabase-js');
    else info(`Skipping — install later with \`${installCmd} @supabase/supabase-js\``);
  } else {
    success(`@supabase/supabase-js ${detection.supabaseVersion ?? ''} found`);
  }

  // Check for @supabase/ssr on Next.js projects
  if (detection.framework.startsWith('nextjs') && !detection.hasSupabaseSsr) {
    const installSsr = interactive
      ? await confirm('Install @supabase/ssr (recommended for Next.js)?', true)
      : options.install;
    if (installSsr) install('@supabase/ssr');
    else info(`Skipping — @supabase/ssr is recommended for Next.js (\`${installCmd} @supabase/ssr\`)`);
  }

  if (detection.envVars.url) {
    success(`Supabase URL found in .env (${detection.envVars.urlVarName})`);
  }

  // ──── Step 5: Options (flags first, then prompts / defaults) ────
  log('');
  const srcDir = normalizeDir(options.src ?? await prompt('Source folder', detection.srcDir, '--src <dir>'));
  const sdkOutput = normalizeDir(options.sdk ?? await prompt('SDK output path', defaultSdkPath(srcDir), '--sdk <dir>'));
  const policyPrefix = options.prefix ?? await prompt('Policy prefix', 'accessnexus', '--prefix <name>');

  const envDbUrl =
    process.env.ACCESSNEXUS_DB_URL || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  const hasRestCredentials = Boolean(detection.envVars.url && detection.envVars.serviceRoleKey);
  let pullFromDb: boolean;
  if (!options.introspect) pullFromDb = false;
  else if (options.dbUrl) pullFromDb = true;
  else if (interactive) pullFromDb = await confirm('Connect to Supabase and import existing tables?', true);
  else pullFromDb = Boolean(envDbUrl) || hasRestCredentials;

  if (!pullFromDb && !interactive && options.introspect) {
    info('No database URL or Supabase service key found — writing a template schema '
      + '(pass --db-url <url> to import an existing database)');
  }

  // ──── Step 6: Schema generation ────
  log('');
  let schemaContent = '';
  let schemaSource: 'template' | 'database' | 'rest' = 'template';
  let introspectedTables: IntrospectedTable[] | null = null;
  let introspectedFunctions: IntrospectedFunction[] = [];

  if (pullFromDb) {
    // A direct DB connection reads policies + functions (the faithful path for
    // adopting an existing project); the REST/OpenAPI path only sees tables.
    if (!options.dbUrl && envDbUrl) info('Found a database URL in the environment');
    const dbUrl =
      options.dbUrl ||
      envDbUrl ||
      (interactive
        ? await prompt('Database URL (imports policies + functions; blank = tables only via REST)')
        : '');

    let done = false;

    if (dbUrl) {
      info('Introspecting database (tables, policies, functions)...');
      try {
        const result = await introspectViaDb(dbUrl);
        if (result.tables.length === 0) {
          info('No tables found in public schema');
          schemaContent = generateSchemaTemplate();
        } else {
          const policyCount = result.tables.reduce((a, t) => a + t.policies.length, 0);
          success(
            `Found ${result.tables.length} tables, ${policyCount} policies, ${result.functions.length} functions`,
          );
          introspectedTables = result.tables;
          introspectedFunctions = result.functions;
          schemaContent = generateSchemaFromIntrospection({
            tables: result.tables,
            functions: result.functions,
            policyPrefix,
          });
          schemaSource = 'database';
        }
        done = true;
      } catch (err: any) {
        if (err instanceof PgDriverMissingError) {
          if (options.dbUrl) {
            throw new CliError('PG_DRIVER_MISSING', 'init --db-url needs the "pg" Postgres driver, which is not installed', {
              hint: 'Install it in your project: npm install -D pg (optional peer dependency of accessnexus), or drop --db-url to import tables via REST.',
              cause: err,
            });
          }
          error('Direct DB introspection skipped: the "pg" driver is not installed (npm install -D pg)');
        } else {
          error(`Direct DB introspection failed: ${err.message}`);
        }
        if (options.dbUrl) {
          throw new CliError('DB_CONNECTION_FAILED', `Could not introspect the database given by --db-url: ${err.message}`, {
            hint: 'Check the URL (Supabase: Dashboard → Connect → "Session pooler" string), or drop --db-url / pass --no-introspect.',
            cause: err,
          });
        }
        info('Falling back to REST (tables only)...');
      }
    }

    if (!done) {
      // REST/OpenAPI path — tables only (policies/functions need a DB connection).
      let supabaseUrl = detection.envVars.url ?? '';
      let serviceRoleKey = detection.envVars.serviceRoleKey ?? '';
      if (interactive) {
        if (!supabaseUrl) supabaseUrl = await prompt('Supabase URL');
        else info(`Using ${detection.envVars.urlVarName}: ${supabaseUrl.slice(0, 30)}...`);
        if (!serviceRoleKey) serviceRoleKey = await promptSecret('Service Role / secret key');
        else info('Using service key from .env');
      }

      if (!supabaseUrl || !serviceRoleKey) {
        info('No Supabase URL + service key available — writing a template schema');
        schemaContent = generateSchemaTemplate();
      } else {
        info('Introspecting via REST...');
        try {
          const result = await introspectDatabase(supabaseUrl, serviceRoleKey);
          if (result.tables.length === 0) {
            info('No tables found in public schema');
            schemaContent = generateSchemaTemplate();
          } else {
            success(`Found ${result.tables.length} table${result.tables.length > 1 ? 's' : ''} (no policies — REST cannot read RLS)`);
            introspectedTables = result.tables;
            schemaContent = generateSchemaFromIntrospection({ tables: result.tables, policyPrefix });
            schemaSource = 'rest';
          }
        } catch (err: any) {
          error(`Failed to introspect: ${err.message}`);
          info('Generating template schema instead');
          schemaContent = generateSchemaTemplate();
        }
      }
    }
  } else {
    schemaContent = generateSchemaTemplate();
  }

  // Write schema
  log('');
  if (existsSync(schemaPath)) {
    const overwrite = interactive ? await confirm('Overwrite existing accessnexus.schema.ts?', false) : options.force;
    if (!overwrite) {
      info('Keeping existing accessnexus.schema.ts');
      record(schemaPath, 'skipped');
    } else {
      writeFileSync(schemaPath, schemaContent, 'utf-8');
      record(schemaPath, 'updated');
      success('accessnexus.schema.ts updated');
    }
  } else {
    writeFileSync(schemaPath, schemaContent, 'utf-8');
    record(schemaPath, 'created');
    success('accessnexus.schema.ts created');
  }

  // ──── Step 7: Generate SDK ────
  const sdkAbsolute = join(projectRoot, sdkOutput);
  mkdirSync(sdkAbsolute, { recursive: true });

  if (introspectedTables && introspectedTables.length > 0) {
    info('Generating SDK...');
    const runtimeSchema = buildRuntimeSchema(introspectedTables);
    const adapter = new SupabaseAdapter({ policyPrefix });
    const sdk = adapter.generateClient(runtimeSchema);

    log('');
    log(`  ${c.bold('Typed SDK:')}`);
    for (const file of sdk) {
      const fullPath = join(sdkAbsolute, file.path);
      const existed = existsSync(fullPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, 'utf-8');
      record(fullPath, existed ? 'updated' : 'created');
      success(relative(projectRoot, fullPath));
    }

    // RLS SQL comes from `accessnexus generate`, which reads the imported
    // policies from accessnexus.schema.ts (this runtime schema has none).
  } else {
    info('SDK generation skipped (no tables defined yet)');
    info(`Edit accessnexus.schema.ts then run: ${c.cyan('npx accessnexus generate')}`);
  }

  // ──── Step 8: Framework-specific files ────
  log('');
  log(`  ${c.bold('Framework files:')}`);

  // Wrap an existing Supabase client instead of creating a duplicate one.
  const existing = resolveExistingClient(detection.existingClient, sdkOutput);
  if (existing) {
    for (const side of ['browser', 'server'] as const) {
      const e = existing[side];
      if (e) info(`Reusing existing Supabase ${side} client (${c.cyan(e.importPath)}) — wrapping, not duplicating`);
    }
  }

  const templateFiles = generateFrameworkFiles({
    framework: detection.framework,
    sdkOutputPath: sdkOutput,
    existing,
  });

  for (const file of templateFiles) {
    const filePath = join(projectRoot, file.path);
    if (existsSync(filePath)) {
      info(`${file.path} already exists — skipping`);
      record(filePath, 'skipped');
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, 'utf-8');
      record(filePath, 'created');
      success(relative(projectRoot, filePath));
    }
  }

  // ──── Step 9: accessnexus.config.ts + package.json script ────
  // The config pins where `generate` writes the SDK, so a plain
  // `npx accessnexus generate` updates the same files the app imports.
  log('');
  const existingConfig = CONFIG_FILES.find((file) => existsSync(join(projectRoot, file)));
  if (existingConfig) {
    info(`${existingConfig} already exists — leaving it unchanged`);
    record(join(projectRoot, existingConfig), 'skipped');
  } else {
    const configPath = join(projectRoot, 'accessnexus.config.ts');
    writeFileSync(configPath, renderConfig(sdkOutput, policyPrefix), 'utf-8');
    record(configPath, 'created');
    success('accessnexus.config.ts created');
  }

  const pkgPath = join(projectRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (!pkg.scripts) pkg.scripts = {};

  if (!pkg.scripts.accessnexus) {
    pkg.scripts.accessnexus = 'accessnexus generate';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    record(pkgPath, 'updated');
    success('Added "accessnexus" script to package.json');
  } else {
    info('"accessnexus" script already exists in package.json');
  }

  // ──── Step 10: Agent instructions ────
  const agents = options.agents
    ? writeAgentInstructions(projectRoot, {
      schemaPath: 'accessnexus.schema.ts',
      sdkPath: sdkOutput,
      generatedDir: 'generated',
    })
    : null;
  reportAgents(agents);

  // ──── Step 11: Summary ────
  const importHints = clientImportHints(detection.framework, sdkOutput);
  const nextSteps = [
    introspectedTables && introspectedTables.length > 0
      ? 'Review accessnexus.schema.ts and refine the policies'
      : 'Edit accessnexus.schema.ts and define your tables',
    'Run `npx accessnexus validate` then `npx accessnexus generate` (or `npm run accessnexus`) after every schema change',
    `Import the client: ${importHints.join(' / ')}`,
    'Apply SQL with `npx accessnexus push --dry-run`, then `npx accessnexus push`',
  ];

  log('');
  log(`${c.green('✓')} ${c.bold(c.cyan('AccessNexus'))} initialized!\n`);
  log(c.bold('Next steps:'));
  nextSteps.forEach((step, i) => log(`  ${i + 1}. ${step}`));
  if (agents) log(`\n  ${c.dim('AI agents: instructions written to AGENTS.md (reference: node_modules/accessnexus/llms.txt)')}`);
  log('');

  return {
    status: 'initialized',
    framework: detection.framework,
    schemaSource,
    sdkPath: sdkOutput,
    policyPrefix,
    installed,
    files,
    agents,
    nextSteps,
  };
}

/**
 * How to import the client, as real specifiers: a project-relative folder such
 * as `lib/accessnexus` is not one (Node/TS would look for a package named `lib`).
 * Next.js gets its default `@/` alias for `src/`; other bundlers resolve
 * extensionless relative paths; plain Node ESM needs the `.js` file.
 */
export function clientImportHints(framework: string, sdkOutput: string): string[] {
  const rel = sdkOutput === '.' ? '.' : `./${sdkOutput}`;
  const where = ' (path relative to the project root; adjust it to the importing file)';
  if (framework.startsWith('nextjs')) {
    const base = sdkOutput.startsWith('src/') ? `@/${sdkOutput.slice(4)}` : rel;
    const note = base.startsWith('@/') ? ' (the default `@/` → `src/` alias)' : where;
    return [
      `Server: import { createServerAccessNexus } from '${base}/server'`,
      `Client: import { accessnexus } from '${base}/browser'${note}`,
    ];
  }
  if (framework === 'node') return [`import { accessnexus } from '${rel}/index.js'${where}`];
  return [`import { accessnexus } from '${rel}'${where}`];
}

function reportAgents(agents: ReturnType<typeof writeAgentInstructions> | null): void {
  if (!agents) {
    info('Skipped AGENTS.md (--no-agents)');
    return;
  }
  if (agents.agentsMd === 'unchanged') info('AGENTS.md already has the AccessNexus block');
  else success(`AGENTS.md ${agents.agentsMd} (AccessNexus block for coding agents)`);
  if (agents.claudeMd === 'updated') success('CLAUDE.md now points to AGENTS.md');
}

function quote(value: string): string {
  return `'${value.replace(/[\\']/g, '\\$&')}'`;
}

function renderConfig(sdkOutput: string, policyPrefix: string): string {
  return `import { defineConfig } from 'accessnexus';

// AccessNexus config — read by \`npx accessnexus generate | diff | push\`.
// Reference: node_modules/accessnexus/llms.txt
export default defineConfig({
  schema: './accessnexus.schema.ts',
  output: {
    dir: './generated',
    sdk: ${quote(`./${sdkOutput}`)},
  },
  naming: { policyPrefix: ${quote(policyPrefix)} },
});
`;
}

/**
 * Turn detected existing-client file paths into import specifiers relative to the
 * SDK output directory (where the wrapper files are written).
 */
function resolveExistingClient(
  existing: ExistingSupabase | undefined,
  sdkOutput: string,
): { browser?: ResolvedExisting; server?: ResolvedExisting } | undefined {
  if (!existing) return undefined;

  const toSpecifier = (file: string): string => {
    let rel = relative(sdkOutput, file).split('\\').join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
  };

  const resolved: { browser?: ResolvedExisting; server?: ResolvedExisting } = {};
  for (const side of ['browser', 'server'] as const) {
    const e = existing[side];
    if (!e) continue;
    resolved[side] = {
      importPath: toSpecifier(e.file),
      symbol: e.symbol,
      callable: e.callable,
      async: e.async,
    };
  }
  return resolved.browser || resolved.server ? resolved : undefined;
}
