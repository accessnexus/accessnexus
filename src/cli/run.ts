// ============================================
// AccessNexus CLI - command implementations
// Entry point: ./index.ts (the `accessnexus` bin) calls runCli(argv).
//
// Contract (documented in llms.txt):
//   - every command is non-interactive unless stdin is a TTY;
//   - `--json` prints exactly one JSON object on stdout;
//   - exit 0 = ok, 1 = user-fixable error, 2 = internal error.
// ============================================

import { spawnSync } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EDGE_FUNCTIONS_TOML_BEGIN, EDGE_FUNCTIONS_TOML_END, SupabaseAdapter } from '../adapters/supabase/adapter.js';
import { defineConfig, type ResolvedConfig } from '../core/schema/builders.js';
import type { GeneratedOutput, SchemaDef } from '../core/types/index.js';
import { GLOBAL_FLAGS, closest, formatFlags, parseFlags, type FlagSpecs, type ParsedFlags } from './args.js';
import { dbConnectTimeoutMs } from './db-timeout.js';
import {
  buildDiff,
  collectExistingFiles,
  renderUnifiedDiff,
  stripVolatileHeader,
  type ExpectedFile,
  type OutputScope,
} from './diff.js';
import { runInit } from './init/index.js';
import { findDestructiveStatements, findNotNullColumnAdds, type DestructiveStatement } from './destructive.js';
import { TEST_DB_STANDINS_SQL } from '../testing/index.js';
import { discardLastMigration, lastSnapshotMigration, resolveVersionedMigrations } from './migrations.js';
import {
  CliError,
  EXIT,
  brand,
  configureUi,
  debug,
  emitJson,
  errorToJson,
  isJsonMode,
  log,
  paint,
  printError,
  printIssue,
  toCliError,
  type SchemaIssue,
} from './output.js';
import { checkSchema, summarizeSchema } from './schema-check.js';
import {
  captureSnapshot,
  snapshotFunctionOids,
  diffSnapshots,
  findRiskyChanges,
  functionsDefinedIn,
  renderPlan,
  summarizeChanges,
  type PlanChange,
  type RiskyChange,
  type SnapshotScope,
} from './plan.js';

const DEFAULT_SCHEMA_PATH = './accessnexus.schema.ts';
const DEFAULT_SEED_PATH = './accessnexus.seed.ts';
const CONFIG_FILES = ['accessnexus.config.ts', 'accessnexus.config.js', 'accessnexus.config.mjs'];

type CommandName = 'init' | 'generate' | 'diff' | 'push' | 'seed' | 'validate' | 'migration' | 'test-db';
type CommandResult = Record<string, unknown>;

const SCHEMA_FLAG = { kind: 'string', value: '<path>', description: 'Schema file (default: config.schema or ./accessnexus.schema.ts)' } as const;
const OUTPUT_FLAGS: FlagSpecs = {
  output: { kind: 'string', value: '<dir>', description: 'Write/read every output folder under <dir> (overrides config output paths; default: ./generated)' },
  'sql-only': { kind: 'boolean', description: 'Only SQL (migrations, policies, triggers, RPCs)' },
  'sdk-only': { kind: 'boolean', description: 'Only the typed SDK' },
  prefix: { kind: 'string', value: '<name>', description: 'Policy name prefix (default: accessnexus)' },
};
const DB_FLAGS: FlagSpecs = {
  url: { kind: 'string', value: '<db-url>', description: 'Postgres URL (fallback: adapter dbUrlEnv, ACCESSNEXUS_DB_URL, SUPABASE_DB_URL, DATABASE_URL)' },
  'db-url': { kind: 'string', value: '<db-url>', description: 'Alias of --url (same flag init uses)' },
  adapter: { kind: 'string', value: '<name>', description: 'Adapter to use when several are configured' },
  target: { kind: 'string', value: '<name>', description: 'Target from config.targets' },
  'dry-run': { kind: 'boolean', description: 'Show what would run without touching the database' },
};

export const COMMANDS: Readonly<Record<CommandName, { summary: string; flags: FlagSpecs; examples: string[] }>> = {
  init: {
    summary: 'Set up AccessNexus in a project (schema, config, SDK wrappers, AGENTS.md)',
    flags: {
      yes: { kind: 'boolean', description: 'Non-interactive: accept defaults, never prompt (alias -y)' },
      src: { kind: 'string', value: '<dir>', description: 'Source folder (default: detected, src or .)' },
      sdk: { kind: 'string', value: '<dir>', description: 'SDK output folder (default: <src>/lib/accessnexus)' },
      prefix: { kind: 'string', value: '<name>', description: 'Policy name prefix (default: accessnexus)' },
      'db-url': { kind: 'string', value: '<url>', description: 'Postgres URL to import tables, policies and functions' },
      'no-introspect': { kind: 'boolean', description: 'Do not connect to the database; write a template schema' },
      install: { kind: 'boolean', description: 'With --yes: install missing @supabase/* packages' },
      force: { kind: 'boolean', description: 'With --yes: overwrite an existing accessnexus.schema.ts' },
      'no-agents': { kind: 'boolean', description: 'Do not write the AccessNexus block into AGENTS.md / CLAUDE.md' },
    },
    examples: ['npx accessnexus init', 'npx accessnexus init --yes --no-introspect', 'npx accessnexus init --yes --db-url "$SUPABASE_DB_URL"'],
  },
  generate: {
    summary: 'Generate migrations, RLS policies, triggers, RPCs and the typed SDK',
    flags: { schema: SCHEMA_FLAG, ...OUTPUT_FLAGS },
    examples: ['npx accessnexus generate', 'npx accessnexus generate --json', 'npx accessnexus generate --sql-only'],
  },
  diff: {
    summary: 'Show what generate would change, without writing (run it before generate)',
    flags: {
      schema: SCHEMA_FLAG,
      ...OUTPUT_FLAGS,
      check: { kind: 'boolean', description: 'Exit 1 when generated files are out of date (with --against-db: when the database would change) (for CI)' },
      'against-db': { kind: 'boolean', description: 'Rehearse the push against the live database in a rolled-back transaction and list catalog changes + riskyChanges' },
      url: DB_FLAGS.url,
      'db-url': DB_FLAGS['db-url'],
      adapter: DB_FLAGS.adapter,
      target: DB_FLAGS.target,
      'allow-destructive': { kind: 'boolean', description: 'With --against-db: plan as push --allow-destructive would' },
      'replace-foreign-policies': { kind: 'boolean', description: 'With --against-db: plan as push --replace-foreign-policies would (drops included)' },
      'replace-foreign-triggers': { kind: 'boolean', description: 'With --against-db: plan as push --replace-foreign-triggers would (drops included)' },
    },
    examples: ['npx accessnexus diff', 'npx accessnexus diff --json', 'npx accessnexus diff --check', 'npx accessnexus diff --against-db --json'],
  },
  validate: {
    summary: 'Check the schema for errors without writing anything',
    flags: {
      schema: SCHEMA_FLAG,
      'against-db': { kind: 'boolean', description: 'Also compile the generated SQL (raw policy/trigger/RPC bodies included) in a rolled-back transaction on the database' },
      url: DB_FLAGS.url,
      'db-url': DB_FLAGS['db-url'],
      adapter: DB_FLAGS.adapter,
      target: DB_FLAGS.target,
      prefix: OUTPUT_FLAGS.prefix,
      output: OUTPUT_FLAGS.output,
    },
    examples: ['npx accessnexus validate', 'npx accessnexus validate --json', 'npx accessnexus validate --against-db --json'],
  },
  push: {
    summary: 'Apply the generated SQL to the database (refuses stale output and unconfirmed data loss)',
    flags: {
      ...DB_FLAGS,
      output: OUTPUT_FLAGS.output,
      prefix: OUTPUT_FLAGS.prefix,
      schema: SCHEMA_FLAG,
      'allow-destructive': { kind: 'boolean', description: 'Apply pending migrations that DROP tables/columns or change column types' },
      'replace-foreign-policies': { kind: 'boolean', description: 'Drop RLS policies on managed tables that AccessNexus did not generate (same transaction)' },
      'replace-foreign-triggers': { kind: 'boolean', description: 'Drop triggers on managed tables that AccessNexus did not generate (same transaction)' },
      seed: { kind: 'boolean', description: 'Also run the seed (accessnexus.seed.ts / config.seed) after pushing' },
      'allow-remote-seed': { kind: 'boolean', description: 'With --seed: allow seeding a hosted Supabase database' },
    },
    examples: ['npx accessnexus push --dry-run', 'npx accessnexus push --json', 'npx accessnexus push --url "$SUPABASE_DB_URL"'],
  },
  seed: {
    summary: 'Insert seed data from accessnexus.seed.ts',
    flags: {
      ...DB_FLAGS,
      schema: SCHEMA_FLAG,
      prefix: OUTPUT_FLAGS.prefix,
      seed: { kind: 'string', value: '<path>', description: 'Seed file (default: config.seed or ./accessnexus.seed.ts)' },
      'allow-remote-seed': { kind: 'boolean', description: 'Allow seeding a hosted Supabase database (*.supabase.co / *.supabase.com)' },
    },
    examples: ['npx accessnexus seed --dry-run', 'npx accessnexus seed --json'],
  },
  migration: {
    summary: 'migration discard: drop the newest migration if no database applied it and restore the snapshot; migration amend: discard + generate; migration data <name>: create a data migration (backfill)',
    flags: {
      url: DB_FLAGS.url,
      'db-url': DB_FLAGS['db-url'],
      adapter: DB_FLAGS.adapter,
      target: DB_FLAGS.target,
      schema: SCHEMA_FLAG,
      ...OUTPUT_FLAGS,
      last: { kind: 'boolean', description: 'Discard the newest migration (the default and only mode)' },
      force: { kind: 'boolean', description: 'Discard without checking a database (no URL configured): you vouch it was never applied anywhere' },
    },
    examples: ['npx accessnexus migration discard --json', 'npx accessnexus migration amend --target staging --json', 'npx accessnexus migration data backfill_task_org --json'],
  },
  'test-db': {
    summary: 'test-db up | down: a disposable local Supabase Postgres (Docker) ready for RLS tests',
    flags: {
      port: { kind: 'string', value: '<port>', description: 'Host port (default 55433)' },
      name: { kind: 'string', value: '<name>', description: 'Container name (default accessnexus-test-db)' },
      image: { kind: 'string', value: '<image>', description: 'Image (default ghcr.io/supabase/postgres:15.19.0.007)' },
      push: { kind: 'boolean', description: 'With up: also run `push` against it' },
      schema: SCHEMA_FLAG,
      output: OUTPUT_FLAGS.output,
    },
    examples: ['npx accessnexus test-db up --push --json', 'npx accessnexus test-db down'],
  },
};

const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[];

/**
 * Run the CLI with the given arguments (without `node` and the script path).
 * Never calls process.exit — returns the exit code instead.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const wantsJson = argv.includes('--json');
  configureUi({ json: wantsJson, verbose: argv.includes('--verbose') });

  const first = argv[0];
  let command: string = first ?? 'help';

  try {
    if (first === undefined || first === 'help' || first === '--help' || first === '-h' || first === '--json' || first === '--verbose') {
      const topic = first === 'help' ? argv[1] : undefined;
      const known = topic && (COMMAND_NAMES as string[]).includes(topic) ? (topic as CommandName) : null;
      if (wantsJson) emitJson(helpJson(known));
      else if (known) printCommandHelp(known);
      else printHelp();
      return EXIT.OK;
    }
    if (first === 'version' || first === '--version' || first === '-v') {
      if (wantsJson) emitJson({ ok: true, command: 'version', version: packageVersion() });
      else console.log(packageVersion());
      return EXIT.OK;
    }
    if (!(COMMAND_NAMES as string[]).includes(first)) {
      command = first;
      const suggestion = closest(first, COMMAND_NAMES);
      throw new CliError('UNKNOWN_COMMAND', `Unknown command "${first}"`, {
        hint: suggestion
          ? `Did you mean \`npx accessnexus ${suggestion}\`? Commands: ${COMMAND_NAMES.join(', ')}.`
          : `Commands: ${COMMAND_NAMES.join(', ')}. Run \`npx accessnexus help\`.`,
      });
    }

    const name = first as CommandName;
    let rest = argv.slice(1);
    let testDbAction: 'up' | 'down' | null = null;
    if (name === 'test-db') {
      const action = rest[0];
      if (action !== 'up' && action !== 'down' && !rest.includes('--help') && !rest.includes('-h')) {
        throw new CliError('UNKNOWN_COMMAND', `Unknown test-db action ${action === undefined ? '(none)' : `"${action}"`}`, {
          hint: 'Use `npx accessnexus test-db up` or `npx accessnexus test-db down`.',
        });
      }
      if (action === 'up' || action === 'down') {
        testDbAction = action;
        rest = rest.slice(1);
      }
    }
    let migrationSub: { sub: 'discard' | 'amend' | 'data'; name?: string } | null = null;
    if (name === 'migration') {
      const sub = rest[0];
      if (sub !== 'discard' && sub !== 'amend' && sub !== 'data' && !rest.includes('--help') && !rest.includes('-h')) {
        throw new CliError('UNKNOWN_COMMAND', `Unknown migration subcommand ${sub === undefined ? '(none)' : `"${sub}"`}`, {
          hint: 'Use `npx accessnexus migration discard` (drop the newest, never-applied migration), `migration amend` '
            + '(discard + generate) or `migration data <name>` (new data migration).',
        });
      }
      if (sub === 'discard' || sub === 'amend') {
        migrationSub = { sub };
        rest = rest.slice(1);
      } else if (sub === 'data') {
        const dataName = rest[1];
        if (!dataName || dataName.startsWith('-')) {
          throw new CliError('MISSING_ARGUMENT', 'migration data needs a name', { hint: 'Example: `npx accessnexus migration data backfill_task_org`.' });
        }
        migrationSub = { sub, name: dataName };
        rest = rest.slice(2);
      }
    }
    const flags = parseFlags(rest, COMMANDS[name].flags, name);
    if (migrationSub) Object.assign(flags, { _migration: migrationSub });
    if (testDbAction) Object.assign(flags, { _action: testDbAction });
    configureUi({ json: flags.json === true, verbose: flags.verbose === true });
    if (flags.help === true) {
      if (isJsonMode()) emitJson(helpJson(name));
      else printCommandHelp(name);
      return EXIT.OK;
    }

    loadEnvFiles();
    const result = await dispatch(name, flags);
    if (isJsonMode()) emitJson({ ok: true, command: name, version: packageVersion(), ...result });
    return EXIT.OK;
  } catch (err) {
    const error = toCliError(err);
    if (isJsonMode()) {
      emitJson({ ok: false, command, version: packageVersion(), ...(error.data ?? {}), error: errorToJson(error) });
    } else {
      printError(error);
    }
    return error.exitCode;
  }
}

async function dispatch(name: CommandName, flags: ParsedFlags): Promise<CommandResult> {
  switch (name) {
    case 'init':
      return runInit({
        yes: flags.yes === true,
        src: flags.src as string | undefined,
        sdk: flags.sdk as string | undefined,
        prefix: flags.prefix as string | undefined,
        dbUrl: flags['db-url'] as string | undefined,
        introspect: flags['no-introspect'] !== true,
        install: flags.install === true,
        force: flags.force === true,
        agents: flags['no-agents'] !== true,
      });
    case 'generate':
      return runGenerate(flags);
    case 'diff':
      return runDiff(flags);
    case 'validate':
      return runValidate(flags);
    case 'push':
      return runPush(flags);
    case 'seed':
      return runSeed(flags);
    case 'test-db':
      return runTestDb(flags);
    case 'migration': {
      const sub = (flags._migration as unknown as { sub: string } | undefined)?.sub;
      if (sub === 'data') return runMigrationData(flags);
      return runMigrationDiscard(flags, sub === 'amend');
    }
  }
}

async function runMigrationDiscard(opts: ParsedFlags, regenerate: boolean): Promise<CommandResult> {
  log(`\n${brand()} migration ${regenerate ? 'amend' : 'discard'}...\n`);
  const { config, fileConfig } = await loadConfigWithSource(opts);
  const outputBase = config.output.migrations;
  const last = lastSnapshotMigration(outputBase);
  if (!last) {
    throw new CliError('NO_MIGRATION_TO_DISCARD', `No migration snapshot in ${prettyPath(outputBase)}`, {
      hint: 'There is nothing to discard: run `npx accessnexus generate` first.',
    });
  }
  const display = relativePathFromCwd(resolve(outputBase, last));

  let dbUrl: string | undefined;
  try {
    dbUrl = resolveDbUrl(opts, resolveAdapterSelection(opts, config, fileConfig)).dbUrl;
  } catch {
    dbUrl = undefined;
  }
  if (dbUrl) {
    const client = await createPgClient(dbUrl);
    try {
      const table = await client.query(`SELECT to_regclass('public.accessnexus_migrations') IS NOT NULL AS ok`);
      if (table.rows?.[0]?.ok === true) {
        const applied = await client.query(
          `SELECT 1 FROM public.accessnexus_migrations WHERE category = 'migrations' AND filename = $1 AND success = TRUE LIMIT 1`,
          [display],
        );
        if ((applied.rows ?? []).length > 0) {
          throw new CliError('MIGRATION_ALREADY_APPLIED', `${display} was already applied to ${redactUrl(dbUrl)}; it cannot be discarded`, {
            hint: 'Applied migrations are immutable. Change accessnexus.schema.ts and run `npx accessnexus generate` to get a new __changes migration that fixes it.',
            data: { migration: display, database: redactUrl(dbUrl) },
          });
        }
      }
    } finally {
      await client.end().catch(() => {});
    }
  } else if (opts.force !== true) {
    throw new CliError('MIGRATION_DISCARD_NEEDS_DB', `Cannot check whether ${display} was applied: no database URL`, {
      hint: 'Pass --url / --target (or set the configured env var) so discard can confirm the database never applied it. '
        + 'Without a database, pass --force only if no environment ever applied it.',
      data: { migration: display },
    });
  }

  let restoredTo: string | null;
  try {
    restoredTo = discardLastMigration(outputBase).restoredTo;
  } catch (err) {
    if ((err as Error).message === 'HISTORY_MISSING') {
      throw new CliError('MIGRATION_HISTORY_MISSING', `The snapshot has no record of the state before ${display}`, {
        hint: 'It was written by accessnexus < 0.4.1, which kept only the latest state. Nothing was deleted. '
          + 'Rebuild the previous snapshot by hand, or generate a new __changes migration that undoes the change.',
        data: { migration: display },
      });
    }
    throw err;
  }
  log(`  ${paint.green('✓')} Discarded ${display}${restoredTo ? ` (snapshot restored to ${restoredTo})` : ' (snapshot removed: the next generate writes a new __init)'}`);
  log(`  ${paint.gray(dbUrl ? `Checked: ${redactUrl(dbUrl)} never applied it.` : 'Not checked against a database (--force).')}\n`);

  const result: CommandResult = {
    discarded: display,
    restoredTo: restoredTo ? relativePathFromCwd(resolve(outputBase, restoredTo)) : null,
    checkedDatabase: dbUrl ? redactUrl(dbUrl) : null,
  };
  if (!regenerate) {
    log(`  ${paint.gray('Nothing regenerated: change the schema, then run `npx accessnexus generate` (or use `migration amend`).')}\n`);
    return { ...result, regenerated: null };
  }
  const generate = await runGenerate(opts);
  const files = (generate.files as Array<{ path: string; category: string; status: string }> | undefined) ?? [];
  const regenerated = files.find((f) => f.category === 'migrations' && f.status === 'created' && f.path.endsWith('.sql'))?.path ?? null;
  log(regenerated
    ? `  ${paint.yellow('!')} Regenerated ${regenerated}: the schema still differs from the restored snapshot, so a new pending migration exists.\n`
    : `  ${paint.green('✓')} The schema matches the restored snapshot: no new migration.\n`);
  return { ...result, regenerated, generate };
}

let cachedVersion: string | undefined;

/** Version from the package.json shipped next to dist/ (or src/ in development). */
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion ?? 'unknown';
}

function loadEnvFiles() {
  const envFiles = ['.env', '.env.local'];
  for (const file of envFiles) {
    const fullPath = resolve(process.cwd(), file);
    if (!existsSync(fullPath)) continue;
    const raw = readFileSync(fullPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex <= 0) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// ---- Help ----

/** `help --json` / `<command> --help --json`: the help text as data. */
function helpJson(topic: CommandName | null): Record<string, unknown> {
  const describe = (name: CommandName) => ({
    name,
    summary: COMMANDS[name].summary,
    flags: Object.entries({ ...COMMANDS[name].flags, ...GLOBAL_FLAGS }).map(([flag, spec]) => ({
      name: `--${flag}`,
      kind: spec.kind,
      ...(spec.kind === 'string' ? { value: spec.value ?? '<value>' } : {}),
      description: spec.description,
    })),
    examples: COMMANDS[name].examples,
  });
  return {
    ok: true,
    command: 'help',
    version: packageVersion(),
    topic,
    commands: (topic ? [topic] : COMMAND_NAMES).map(describe),
    exitCodes: { 0: 'success', 1: 'user-fixable error (read error.hint)', 2: 'internal error (a AccessNexus bug)' },
    docs: 'node_modules/accessnexus/llms.txt',
  };
}

function printHelp() {
  const rows = COMMAND_NAMES.map((name) => `  ${name.padEnd(10)} ${COMMANDS[name].summary}`).join('\n');
  log(`
${brand()} — The missing schema layer for Supabase

${paint.bold('Usage:')}
  npx accessnexus <command> [flags]
  npx accessnexus <command> --help

${paint.bold('Commands:')}
${rows}
  help       Show help (also: <command> --help)
  version    Print the installed version

${paint.bold('Flags for every command:')}
  --json       Print one JSON object on stdout (for scripts and AI agents)
  --verbose    Debug output and stack traces (same as DEBUG=accessnexus)
  --config     Config file (default: accessnexus.config.{ts,js,mjs})

${paint.bold('Exit codes:')}
  0  success
  1  user-fixable error (bad flag, missing file, schema error, database rejected SQL)
  2  internal error (a AccessNexus bug — re-run with --verbose and report it)

${paint.bold('Agent workflow:')}
  edit accessnexus.schema.ts → validate --json → diff --json (review SQL) → generate --json → diff --against-db --json (review riskyChanges) → push

${paint.bold('Docs for AI agents:')} node_modules/accessnexus/llms.txt
`);
}

function printCommandHelp(name: CommandName) {
  const spec = COMMANDS[name];
  log(`
${brand()} ${paint.bold(name)} — ${spec.summary}

${paint.bold('Usage:')}
  npx accessnexus ${name} [flags]

${paint.bold('Flags:')}
${formatFlags(spec.flags)}

${paint.bold('Examples:')}
${spec.examples.map((e) => `  ${e}`).join('\n')}
`);
}

// ---- Module loading ----

type RawConfig = Record<string, any> | null;
type LoadedConfig = {
  config: ResolvedConfig;
  fileConfig: RawConfig;
  configPath: string | null;
};

/** Node errors that mean "could not load this file as-is" (only seen without esbuild). */
const LOADER_ERROR_CODES = new Set([
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
  'ERR_INVALID_TYPESCRIPT_SYNTAX',
  'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
  'ERR_IMPORT_ATTRIBUTE_MISSING',
]);

function isLoaderError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  // A missing npm package will be just as missing after bundling — report it directly.
  if (code === 'ERR_MODULE_NOT_FOUND' && /Cannot find package/.test(String((err as Error).message))) return false;
  if (typeof code === 'string' && LOADER_ERROR_CODES.has(code)) return true;
  return err instanceof SyntaxError;
}

/**
 * Import a TS/JS file. Bundles it with esbuild first (a runtime dependency), so
 * every Node >= 20 loads the same way: TypeScript-only syntax, extensionless
 * relative imports (`./cols`) and enums all work. Packages (`accessnexus`, ...)
 * stay external and resolve from the project's node_modules. Falls back to a
 * native import (Node >= 22.18 strips types) only when esbuild is missing.
 * Errors thrown by the module's own code are re-thrown unchanged so the caller
 * can report them precisely.
 */
async function importFile(absolute: string, label: string): Promise<Record<string, unknown>> {
  let esbuild: typeof import('esbuild') | undefined;
  try {
    esbuild = await import('esbuild');
  } catch (err) {
    debug(`esbuild unavailable (${(err as Error).message}); using a native import`);
  }

  if (!esbuild) {
    try {
      return await import(pathToFileURL(absolute).href);
    } catch (nativeError) {
      if (!isLoaderError(nativeError)) throw nativeError;
      throw loaderErrorWithoutEsbuild(nativeError, label, absolute);
    }
  }

  let code: string;
  try {
    // Feed the entry through stdin: no entry-point resolution, so a long-lived
    // esbuild service never serves a stale directory listing for it.
    const ext = absolute.slice(absolute.lastIndexOf('.') + 1);
    const loader = ext === 'ts' || ext === 'mts' || ext === 'cts' ? 'ts' : ext === 'tsx' ? 'tsx' : 'js';
    const result = esbuild.buildSync({
      stdin: {
        contents: readFileSync(absolute, 'utf-8'),
        sourcefile: absolute,
        resolveDir: dirname(absolute),
        loader,
      },
      absWorkingDir: dirname(absolute),
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
    });
    // Resolve imports from where the bundle will run (the temp folder below).
    code = linkOwnPackage(result.outputFiles[0].text, bundleTempDir(dirname(absolute)));
  } catch (buildError: any) {
    const first = buildError?.errors?.[0];
    const where = first?.location ? ` (${first.location.file}:${first.location.line}:${first.location.column})` : '';
    const missing = /Could not resolve "([^"]+)"/.exec(String(first?.text ?? ''));
    if (missing) {
      throw new CliError(`${label.startsWith('Config') ? 'CONFIG' : label.startsWith('Seed') ? 'SEED' : 'SCHEMA'}_LOAD_FAILED`,
        `${label} ${prettyPath(absolute)} imports "${missing[1]}", which cannot be found${where}`, {
          hint: missing[1].startsWith('.')
            ? `Fix the import path in ${prettyPath(absolute)}.`
            : `Install it (npm install -D ${missing[1]}) or fix the import in ${prettyPath(absolute)}.`,
          cause: buildError,
        });
    }
    throw new CliError('MODULE_SYNTAX_ERROR', `${label} ${prettyPath(absolute)} does not compile: ${first?.text ?? buildError?.message}${where}`, {
      hint: 'Fix the TypeScript error at the location shown, then re-run.',
      cause: buildError,
    });
  }

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = bundleTempDir(dirname(absolute));
  const tempPath = join(tempDir, `.accessnexus-temp-${uniqueSuffix}.mjs`);
  writeFileSync(tempPath, code);
  try {
    return await import(pathToFileURL(tempPath).href);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch { }
  }
}

/**
 * Where to write the bundled temp module. It must resolve the same packages as
 * the source file, so it goes in `<nearest node_modules>/.cache/accessnexus/`
 * (out of the user's tree, gitignored by convention); without a node_modules
 * folder it sits next to the source file.
 */
function bundleTempDir(sourceDir: string): string {
  let current = sourceDir;
  for (;;) {
    const candidate = join(current, 'node_modules');
    if (existsSync(candidate)) {
      const cacheDir = join(candidate, '.cache', 'accessnexus');
      try {
        mkdirSync(cacheDir, { recursive: true });
        return cacheDir;
      } catch {
        return sourceDir;
      }
    }
    const parent = dirname(current);
    if (parent === current) return sourceDir;
    current = parent;
  }
}

/** Explain a native import failure when esbuild is not available to retry with. */
function loaderErrorWithoutEsbuild(err: unknown, label: string, absolute: string): CliError {
  const code = (err as { code?: unknown })?.code;
  const message = (err as Error)?.message ?? String(err);
  const display = prettyPath(absolute);
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return new CliError('TS_LOADER_MISSING', `${label} ${display} uses TypeScript that Node cannot strip: ${message}`, {
      hint: 'Replace enum / namespace / constructor parameter properties with plain objects and union types, or reinstall accessnexus so its esbuild dependency is present (npm install -D accessnexus).',
      cause: err,
    });
  }
  if (code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' || err instanceof SyntaxError) {
    return new CliError('MODULE_SYNTAX_ERROR', `${label} ${display} has a syntax error: ${message}`, {
      hint: `Fix the syntax error in ${display}, then re-run.`,
      cause: err,
    });
  }
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    return new CliError('TS_LOADER_MISSING', `This Node.js (${process.version}) cannot load ${label} ${display} directly`, {
      hint: 'esbuild (a accessnexus dependency) is missing: reinstall with `npm install -D accessnexus`, or use Node.js >= 22.18, which runs TypeScript natively.',
      cause: err,
    });
  }
  return new CliError('TS_LOADER_MISSING', `Cannot load ${label} ${display}: ${message}`, {
    hint: 'Fix the import named in the message (use explicit file extensions, e.g. ./tables.ts), or reinstall accessnexus so its esbuild dependency is present (npm install -D accessnexus).',
    cause: err,
  });
}

/** Translate an error thrown while importing a user file into an actionable CliError. */
function moduleLoadError(err: unknown, label: string, absolute: string, codePrefix: string): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const display = prettyPath(absolute);

  if (message.startsWith('[AccessNexus]')) {
    return new CliError('SCHEMA_INVALID', message.replace(/^\[AccessNexus\]\s*/, ''), {
      hint: `Fix the definition in ${display} named in the message, then run \`npx accessnexus validate\`.`,
      cause: err,
    });
  }
  const missingPkg = /Cannot find (?:package|module) '([^']+)'/.exec(message);
  if (missingPkg) {
    return new CliError(`${codePrefix}_LOAD_FAILED`, `${label} ${display} imports "${missingPkg[1]}", which is not installed`, {
      hint: missingPkg[1].startsWith('.')
        ? `Fix the import path in ${display}.`
        : `Install it (npm install -D ${missingPkg[1]}) or fix the import in ${display}.`,
      cause: err,
    });
  }
  return new CliError(`${codePrefix}_LOAD_FAILED`, `${label} ${display} threw while loading: ${message}`, {
    hint: `The file runs as code — fix the error in ${display} (re-run with --verbose for the stack trace).`,
    cause: err,
  });
}

/** Load a module and return its default export (or the namespace when there is none). */
async function loadModule(filePath: string, label: string, codePrefix: string): Promise<any> {
  const absolute = resolve(process.cwd(), filePath);
  try {
    const mod = await importFile(absolute, label);
    return (mod as any).default ?? mod;
  } catch (err) {
    throw moduleLoadError(err, label, absolute, codePrefix);
  }
}

async function loadSchema(schemaPath: string): Promise<SchemaDef> {
  const absolute = resolve(process.cwd(), schemaPath);
  if (!existsSync(absolute)) {
    throw new CliError('SCHEMA_NOT_FOUND', `Schema file not found: ${prettyPath(absolute)}`, {
      hint: 'Create it with `npx accessnexus init --yes`, pass --schema <path>, or set "schema" in accessnexus.config.ts.',
    });
  }

  let mod: Record<string, unknown>;
  try {
    mod = await importFile(absolute, 'Schema file');
  } catch (err) {
    throw moduleLoadError(err, 'Schema file', absolute, 'SCHEMA');
  }

  const schema = mod.default;
  if (schema === undefined) {
    const named = Object.keys(mod).filter((key) => key !== 'default');
    throw new CliError('SCHEMA_NO_DEFAULT_EXPORT', `Schema file ${prettyPath(absolute)} has no default export`, {
      hint: named.length > 0
        ? `Add \`export default ${named[0]};\` (or \`export default defineSchema({ ... })\`).`
        : 'End the file with `export default defineSchema({ ... })`.',
    });
  }
  debug(`schema loaded from ${absolute}: ${Object.keys(schema as object).join(', ')}`);
  return schema as SchemaDef;
}

/**
 * Run the static schema checks. Throws SCHEMA_VALIDATION_FAILED on errors;
 * prints and returns warnings.
 */
function assertSchemaValid(schema: SchemaDef, extra: Record<string, unknown> = {}): SchemaIssue[] {
  const issues = checkSchema(schema);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  if (errors.length > 0) {
    throw new CliError(
      'SCHEMA_VALIDATION_FAILED',
      `Schema has ${errors.length} error${errors.length === 1 ? '' : 's'}`,
      {
        hint: 'Fix each error listed (path → what to change), then re-run `npx accessnexus validate`.',
        issues,
        data: { ...extra, issues, summary: { errors: errors.length, warnings: warnings.length } },
      },
    );
  }
  if (warnings.length > 0) {
    log(`  ${paint.yellow(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`)}`);
    for (const warning of warnings) printIssue(warning);
    log('');
  }
  return warnings;
}

// ---- Config ----

async function loadConfigWithSource(cliOpts: ParsedFlags): Promise<LoadedConfig> {
  let fileConfig: Record<string, any> | null = null;
  let configPath: string | null = null;

  if (typeof cliOpts.config === 'string') {
    const explicit = resolve(process.cwd(), cliOpts.config);
    if (!existsSync(explicit)) {
      throw new CliError('CONFIG_NOT_FOUND', `Config file not found: ${cliOpts.config}`, {
        hint: 'Fix the --config path, or drop --config to use accessnexus.config.ts in the current directory.',
      });
    }
    configPath = explicit;
  } else {
    for (const file of CONFIG_FILES) {
      const candidate = resolve(process.cwd(), file);
      if (existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
  }

  if (configPath) {
    const loaded = await loadModule(configPath, 'Config file', 'CONFIG');
    if (!loaded || typeof loaded !== 'object') {
      throw new CliError('CONFIG_INVALID', `Config file ${prettyPath(configPath)} must export an object`, {
        hint: "Use `export default defineConfig({ schema: './accessnexus.schema.ts' })`.",
      });
    }
    fileConfig = loaded;
    log(`  ${paint.green('✓')} Config loaded: ${prettyPath(configPath)}`);
  }

  if (cliOpts['sql-only'] === true && cliOpts['sdk-only'] === true) {
    throw new CliError('INVALID_FLAGS', '--sql-only and --sdk-only cannot be combined', {
      hint: 'Pass at most one of them (none generates everything).',
    });
  }

  const cliOutput = typeof cliOpts.output === 'string' && cliOpts.output !== '' ? cliOpts.output : undefined;
  const outputDir = cliOutput || fileConfig?.output?.dir || './generated';
  const explicitSchema = (cliOpts.schema as string) || fileConfig?.schema;
  // --output puts every category under that directory: the config's
  // per-folder paths (which defineConfig always fills in) must not win over it.
  const folder = (key: 'migrations' | 'policies' | 'triggers' | 'rpcs' | 'sdk'): string | undefined =>
    cliOutput ? undefined : fileConfig?.output?.[key];
  // Edge Functions default to ./supabase/functions (where the Supabase CLI deploys
  // from), not under output.dir; --output still puts them under that directory.
  const functionsFolder = cliOutput ? `${cliOutput}/functions` : fileConfig?.output?.functions;

  const config = defineConfig({
    schema: explicitSchema || DEFAULT_SCHEMA_PATH,
    seed: fileConfig?.seed,
    output: {
      dir: outputDir,
      migrations: folder('migrations'),
      policies: folder('policies'),
      triggers: folder('triggers'),
      rpcs: folder('rpcs'),
      sdk: folder('sdk'),
      functions: functionsFolder,
    },
    adapter: fileConfig?.adapter,
    adapterOptions: fileConfig?.adapterOptions,
    naming: {
      policyPrefix: (cliOpts.prefix as string) || fileConfig?.naming?.policyPrefix,
    },
    generate: {
      sqlOnly: (cliOpts['sql-only'] === true) || fileConfig?.generate?.sqlOnly,
      sdkOnly: (cliOpts['sdk-only'] === true) || fileConfig?.generate?.sdkOnly,
    },
  });

  return { config, fileConfig, configPath };
}

// ---- generate / diff / validate ----

async function runGenerate(opts: ParsedFlags): Promise<CommandResult> {
  log(`\n${brand()} generating...\n`);

  const { config } = await loadConfigWithSource(opts);

  log(`  Schema:     ${config.schema}`);
  log(`  Migrations: ${config.output.migrations}`);
  log(`  Policies:   ${config.output.policies}`);
  log(`  Triggers:   ${config.output.triggers}`);
  log(`  RPCs:       ${config.output.rpcs}`);
  log(`  SDK:        ${config.output.sdk}`);
  log(`  Functions:  ${config.output.functions}`);
  log(`  Prefix:     ${config.naming.policyPrefix}`);
  log('');

  const schema = await loadSchema(config.schema);
  const summary = summarizeSchema(schema);
  log(`  Found ${paint.bold(String(summary.tables.length))} tables\n`);
  const warnings = assertSchemaValid(schema, { schemaPath: config.schema });

  const adapter = new SupabaseAdapter({
    policyPrefix: config.naming.policyPrefix,
    ...config.adapterOptions,
  });

  const generated = collectGeneratedOutputs(schema, adapter, config);
  const files = writeGeneratedOutputs(generated);
  const counts = { created: 0, updated: 0, unchanged: 0 };
  for (const file of files) counts[file.status] += 1;

  const destructive = destructiveInChangedMigrations(
    generated,
    new Set(files.filter((file) => file.status !== 'unchanged').map((file) => file.path)),
  );
  reportDestructive(destructive, 'The new migration');
  const migrationWarnings = notNullColumnWarnings(
    generated,
    new Set(files.filter((file) => file.status !== 'unchanged').map((file) => file.path)),
  );
  reportMigrationWarnings(migrationWarnings);

  log(`${paint.green('✓ Done!')} ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged\n`);

  return {
    schemaPath: config.schema,
    mode: summary.mode,
    files,
    destructive,
    summary: { ...counts, files: files.length, tables: summary.tables.length },
    warnings: [...warnings, ...migrationWarnings],
  };
}

async function runDiff(opts: ParsedFlags): Promise<CommandResult> {
  log(`\n${brand()} diff...\n`);

  const { config, fileConfig } = await loadConfigWithSource(opts);
  const schema = await loadSchema(config.schema);
  const warnings = assertSchemaValid(schema, { schemaPath: config.schema });

  const adapter = new SupabaseAdapter({
    policyPrefix: config.naming.policyPrefix,
    ...config.adapterOptions,
  });

  const generated = collectGeneratedOutputs(schema, adapter, config);
  const expected = generated.flatMap((group) => group.files);
  const scopes = generated.map((group) => group.scope);
  const currentFiles = collectExistingFiles(scopes, expected);
  const changes = buildDiff(expected, currentFiles);

  if (opts['against-db'] === true) {
    return runDiffAgainstDb(opts, { config, fileConfig, schema, generated, warnings, generatedUpToDate: changes.length === 0 });
  }
  let dbConfigured = false;
  try {
    dbConfigured = resolveDbUrl(opts, resolveAdapterSelection(opts, config, fileConfig)).dbUrl !== undefined;
  } catch {
    // adapter/target errors surface in push; the file diff does not need them
  }
  const liveHint = dbConfigured
    ? 'This compares the schema with the generated files, not the database. Run `npx accessnexus diff --against-db --json` to see what push would change in the live database (riskyChanges).'
    : null;

  const summary = { added: 0, modified: 0, removed: 0 };
  for (const change of changes) summary[change.status] += 1;

  const changedPaths = new Set(changes.filter((change) => change.status !== 'removed').map((change) => change.displayPath));
  const destructive = destructiveInChangedMigrations(generated, changedPaths);
  const migrationWarnings = notNullColumnWarnings(generated, changedPaths);
  reportMigrationWarnings(migrationWarnings);

  const result: CommandResult = {
    schemaPath: config.schema,
    changed: changes.length > 0,
    destructive,
    summary,
    changes: changes.map((change) => ({
      path: change.displayPath,
      status: change.status,
      diff: renderUnifiedDiff(change),
    })),
    warnings: [...warnings, ...migrationWarnings],
    ...(liveHint ? { hint: liveHint } : {}),
  };

  if (changes.length === 0) {
    log(`  ${paint.green('✓')} No changes detected\n`);
  } else {
    log(`  ${paint.green('A')} added:    ${summary.added}`);
    log(`  ${paint.yellow('M')} modified: ${summary.modified}`);
    log(`  ${paint.red('D')} removed:  ${summary.removed}`);
    log('');

    for (const change of changes) {
      const marker = change.status === 'added'
        ? paint.green('A')
        : change.status === 'modified'
          ? paint.yellow('M')
          : paint.red('D');
      log(`  ${marker} ${change.displayPath}`);
      log(renderUnifiedDiff(change));
      log('');
    }
    reportDestructive(destructive, 'The pending migration');
  }

  if (liveHint) log(`  ${paint.gray(`Database URL found: run \`npx accessnexus diff --against-db\` to see what push would change in the live database.`)}\n`);

  if (opts.check === true && changes.length > 0) {
    throw new CliError('GENERATED_OUT_OF_DATE', `${changes.length} generated file(s) are out of date`, {
      hint: 'Run `npx accessnexus generate` and commit the result.',
      data: result,
    });
  }

  return result;
}

/**
 * `diff --against-db`: rehearse the push of the SQL the current schema
 * generates (what `generate` + `push` would apply) against the live database.
 */
async function runDiffAgainstDb(
  opts: ParsedFlags,
  input: {
    config: ResolvedConfig;
    fileConfig: LoadedConfig['fileConfig'];
    schema: SchemaDef;
    generated: GeneratedGroup[];
    warnings: SchemaIssue[];
    generatedUpToDate: boolean;
  },
): Promise<CommandResult> {
  const { config, schema, generated } = input;
  const selection = resolveAdapterSelection(opts, config, input.fileConfig);
  const { dbUrl, configuredEnv } = resolveDbUrl(opts, selection);
  if (!dbUrl) {
    const envs = [...new Set([configuredEnv, 'ACCESSNEXUS_DB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL'].filter(Boolean))].join(', ');
    throw new CliError('DB_URL_MISSING', 'diff --against-db needs a database URL, and none was found', {
      hint: `Pass --url <postgres-url> or set one of ${envs} (in the shell, .env or .env.local). `
        + 'Without a database, `npx accessnexus diff` compares the schema with the generated files.',
    });
  }
  await loadPgModule();

  // What push would read after `generate`: the .sql files already on disk (older
  // migrations, leftovers generate does not delete), overridden by what generate writes.
  const outputDirs: Record<string, string> = {
    migrations: config.output.migrations,
    policies: config.output.policies,
    triggers: config.output.triggers,
    rpcs: config.output.rpcs,
  };
  const groups: PushGroup[] = ['migrations', 'policies', 'triggers', 'rpcs'].map((key) => {
    const group = generated.find((g) => g.category === key);
    const byPath = new Map<string, string>();
    for (const file of collectSqlFiles(outputDirs[key])) byPath.set(resolve(file), readFileSync(file, 'utf-8'));
    for (const file of group?.files ?? []) {
      if (file.absolutePath.endsWith('.sql')) byPath.set(resolve(file.absolutePath), file.content);
    }
    const files = [...byPath.keys()]
      .sort(bySqlFileOrder)
      .map((absolute) => ({ path: pendingMigrationName(relativePathFromCwd(absolute), absolute), sql: byPath.get(absolute)! }));
    return { key, title: group?.title ?? key, files };
  });
  const migrationDestructive = groups[0].files.flatMap((file) => findDestructiveStatements(file.path, file.sql));
  const defaultSchema = (config.adapterOptions as { schemaName?: string } | undefined)?.schemaName ?? 'public';
  const base: CommandResult = {
    schemaPath: config.schema,
    againstDb: true,
    adapter: selection.adapter,
    target: selection.targetName ?? null,
    generatedUpToDate: input.generatedUpToDate,
  };
  const ctx: PushContext = {
    groups,
    targets: managedPolicyTargets(schema, config.naming.policyPrefix, defaultSchema),
    policyPrefix: config.naming.policyPrefix,
    replaceForeign: opts['replace-foreign-policies'] === true,
    replaceForeignTriggers: opts['replace-foreign-triggers'] === true,
    allowDestructive: opts['allow-destructive'] === true,
    migrationDestructive,
    base,
  };

  const plan = await rehearsePush(dbUrl, ctx, defaultSchema);
  const result: CommandResult = { ...base, ...plan, warnings: input.warnings };

  if (!input.generatedUpToDate) {
    log(`  ${paint.gray('Planned from the schema (generated files are out of date: run `npx accessnexus generate` before push).')}\n`);
  }
  reportLivePlan(plan);

  if (plan.failed) {
    throw new CliError('PUSH_WOULD_FAIL', `push would fail${plan.failed.file ? ` at ${plan.failed.file}` : ''}: ${plan.failed.message}`, {
      hint: 'Nothing was persisted (the rehearsal was rolled back). Fix the cause in accessnexus.schema.ts or the database, then run the plan again.',
      data: result,
    });
  }
  if (opts.check === true && plan.changed) {
    throw new CliError('LIVE_DB_CHANGES', `push would change ${plan.changes.length} database object(s)`, {
      hint: 'Review `changes` and `riskyChanges`, then push (or fix the schema) and run the check again.',
      data: result,
    });
  }
  return result;
}

async function runValidate(opts: ParsedFlags): Promise<CommandResult> {
  log(`\n${brand()} validating...\n`);

  const { config, fileConfig } = await loadConfigWithSource(opts);
  const schema = await loadSchema(config.schema);
  const summary = summarizeSchema(schema);
  const base = { schemaPath: config.schema, ...summary };

  const warnings = assertSchemaValid(schema, base);

  if (opts['against-db'] === true) {
    // Compile everything push would run (raw SQL bodies included) and roll back.
    const adapter = new SupabaseAdapter({ policyPrefix: config.naming.policyPrefix, ...config.adapterOptions });
    const generated = collectGeneratedOutputs(schema, adapter, config);
    try {
      await runDiffAgainstDb(opts, { config, fileConfig, schema, generated, warnings, generatedUpToDate: true });
    } catch (err) {
      const error = toCliError(err);
      if (error.code !== 'PUSH_WOULD_FAIL') throw err;
      const failed = ((error.data ?? {}) as { failed?: { file?: string | null; message?: string; statement?: string | null; sqlState?: string | null } }).failed;
      const issue: SchemaIssue = {
        severity: 'error',
        code: 'SQL_REJECTED',
        path: schemaPathOfStatement(failed?.file ?? null, failed?.statement ?? null, schema, config.naming.policyPrefix),
        message: `Postgres rejected the generated SQL${failed?.sqlState ? ` (${failed.sqlState})` : ''}: ${failed?.message ?? error.message}`,
        hint: 'Fix the SQL in that part of the schema (policy.custom, trigger.custom functionBody, rpc body, check/default), then run validate again. Nothing was persisted.',
      };
      const issues = [issue, ...warnings];
      throw new CliError('SCHEMA_VALIDATION_FAILED', 'The database rejected the generated SQL', {
        hint: issue.hint,
        issues,
        data: { ...base, issues, summary: { errors: 1, warnings: warnings.length } },
      });
    }
  }

  log(`  ${paint.green('✓')} Schema is valid — ${summary.tables.length} tables (${summary.mode} mode)\n`);
  for (const t of summary.tables) {
    const lock = t.rls ? paint.green('RLS') : paint.yellow('no RLS');
    const realtime = t.realtime === true ? ', Realtime' : '';
    log(`  ${t.name} (${t.columns} columns, ${lock}${t.policies.length ? `: ${t.policies.join('/')}` : ''}${realtime})`);
  }
  if (summary.rpcs.length > 0) log(`\n  RPCs: ${summary.rpcs.join(', ')}`);
  if (summary.channels.length > 0) log(`\n  Channels: ${summary.channels.join(', ')}`);
  if (summary.functions.length > 0) log(`\n  Edge Functions: ${summary.functions.join(', ')}`);
  log('');

  return {
    ...base,
    issues: warnings,
    summary: { errors: 0, warnings: warnings.length },
  };
}

// ---- push / seed ----

type AdapterSelection = {
  adapter: string;
  adapterOptions?: Record<string, unknown>;
  targetName?: string;
};

function envNameFromAdapterOptions(adapterOptions?: Record<string, unknown>): string | undefined {
  if (!adapterOptions) return undefined;

  const direct = adapterOptions.dbUrlEnv;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct;
  }

  const datasource = adapterOptions.datasource;
  if (!datasource || typeof datasource !== 'object') return undefined;
  const url = (datasource as Record<string, unknown>).url;
  if (!url || typeof url !== 'object') return undefined;
  const envName = (url as Record<string, unknown>).env;
  if (typeof envName === 'string' && envName.trim().length > 0) {
    return envName;
  }

  return undefined;
}

function resolveAdapterSelection(
  cliOpts: ParsedFlags,
  resolved: ResolvedConfig,
  fileConfig: RawConfig,
): AdapterSelection {
  const requestedAdapter = typeof cliOpts.adapter === 'string' ? cliOpts.adapter : undefined;
  const requestedTarget = typeof cliOpts.target === 'string' ? cliOpts.target : undefined;

  if (requestedTarget) {
    const target = fileConfig?.targets?.[requestedTarget];
    if (!target) {
      const available = Object.keys(fileConfig?.targets ?? {});
      throw new CliError('TARGET_NOT_FOUND', `Target "${requestedTarget}" not found in config.targets`, {
        hint: available.length > 0 ? `Available targets: ${available.join(', ')}.` : 'Define it under `targets` in accessnexus.config.ts or drop --target.',
      });
    }
    const adapter = target.adapter;
    if (!adapter || typeof adapter !== 'string') {
      throw new CliError('TARGET_INVALID', `Target "${requestedTarget}" must define an adapter`, {
        hint: `Add adapter: 'supabase' to targets.${requestedTarget} in accessnexus.config.ts.`,
      });
    }
    if (requestedAdapter && requestedAdapter !== adapter) {
      throw new CliError('INVALID_FLAGS', `Target "${requestedTarget}" uses adapter "${adapter}", but --adapter "${requestedAdapter}" was provided`, {
        hint: 'Pass only --target, or an --adapter that matches it.',
      });
    }
    return {
      adapter,
      adapterOptions: target.adapterOptions as Record<string, unknown> | undefined,
      targetName: requestedTarget,
    };
  }

  const candidates: AdapterSelection[] = [];
  if (Array.isArray(fileConfig?.adapters) && fileConfig?.adapters.length > 0) {
    for (const entry of fileConfig.adapters) {
      if (typeof entry === 'string') {
        candidates.push({ adapter: entry });
        continue;
      }
      if (entry && typeof entry === 'object') {
        const adapter = typeof entry.adapter === 'string'
          ? entry.adapter
          : typeof entry.name === 'string'
            ? entry.name
            : undefined;
        if (!adapter) continue;
        candidates.push({
          adapter,
          adapterOptions: entry.adapterOptions as Record<string, unknown> | undefined,
        });
      }
    }
  } else {
    candidates.push({
      adapter: resolved.adapter,
      adapterOptions: resolved.adapterOptions,
    });
  }

  const filtered = requestedAdapter
    ? candidates.filter((candidate) => candidate.adapter === requestedAdapter)
    : candidates;

  if (filtered.length === 0) {
    const available = [...new Set(candidates.map((candidate) => candidate.adapter))];
    const options = available.length > 0 ? available.join(', ') : 'none';
    throw new CliError('ADAPTER_NOT_FOUND', `Adapter "${requestedAdapter}" not found`, {
      hint: `Available adapters: ${options}.`,
    });
  }

  if (filtered.length > 1) {
    const options = [...new Set(filtered.map((candidate) => candidate.adapter))].join(', ');
    throw new CliError('ADAPTER_AMBIGUOUS', `Multiple adapters configured (${options})`, {
      hint: 'Pick one with --adapter <name> or --target <name>.',
    });
  }

  if (filtered[0].adapter !== 'supabase') {
    throw new CliError('ADAPTER_UNSUPPORTED', `Adapter "${filtered[0].adapter}" is not supported`, {
      hint: "Only the 'supabase' adapter exists today. Set adapter: 'supabase' in accessnexus.config.ts.",
    });
  }

  return filtered[0];
}

function resolveDbUrl(opts: ParsedFlags, selection: AdapterSelection): { dbUrl?: string; configuredEnv?: string } {
  const configuredEnv = envNameFromAdapterOptions(selection.adapterOptions);
  const fromConfiguredEnv = configuredEnv ? process.env[configuredEnv] : undefined;
  const flagUrl = opts.url as string | undefined;
  const aliasUrl = opts['db-url'] as string | undefined;
  if (flagUrl !== undefined && aliasUrl !== undefined && flagUrl !== aliasUrl) {
    throw new CliError('INVALID_FLAG_VALUE', '--url and --db-url were both passed with different values', {
      hint: '--db-url is an alias of --url: pass only one of them.',
    });
  }
  const dbUrl = (flagUrl ?? aliasUrl)
    ?? fromConfiguredEnv
    ?? process.env.ACCESSNEXUS_DB_URL
    ?? process.env.SUPABASE_DB_URL
    ?? process.env.DATABASE_URL;
  return { dbUrl: dbUrl || undefined, configuredEnv };
}

function missingDbUrlError(command: string, configuredEnv?: string): CliError {
  const envs = [...new Set([configuredEnv, 'ACCESSNEXUS_DB_URL', 'SUPABASE_DB_URL', 'DATABASE_URL'].filter(Boolean))].join(', ');
  return new CliError('DB_URL_MISSING', `${command} needs a database URL, and none was found`, {
    hint: `Pass --url <postgres-url> or set one of ${envs} (in the shell, .env or .env.local). `
      + 'Supabase: Dashboard → Connect → "Session pooler" connection string. '
      + `Use \`${command} --dry-run\` to preview without a database.`,
  });
}

function collectSqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  const stack = [resolve(dir)];

  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!fullPath.endsWith('.sql')) continue;
      files.push(fullPath);
    }
  }

  return files.sort(bySqlFileOrder);
}

/**
 * Apply order of SQL files: by file name, then path. Migration names start with
 * their timestamp, so data migrations (`migrations/data/<timestamp>__<name>.sql`)
 * run between the schema migrations generated before and after them.
 */
function bySqlFileOrder(a: string, b: string): number {
  const byName = basename(a).localeCompare(basename(b));
  return byName !== 0 ? byName : a.localeCompare(b);
}

function shouldForceSsl(dbUrl: string): boolean {
  if (/\bsslmode=disable\b/i.test(dbUrl)) return false;
  if (/\bsslmode=(require|verify-ca|verify-full)\b/i.test(dbUrl)) return true;
  return /supabase\.(co|in)/i.test(dbUrl);
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeSqlForChecksum(sql: string): string {
  return sql
    .replace(/^-- Generated at: .*\n?/gm, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/** Import the optional `pg` peer dependency, or explain how to install it. */
async function loadPgModule(): Promise<any> {
  const moduleName = 'pg';
  try {
    return await import(moduleName);
  } catch (error: any) {
    throw new CliError('PG_DRIVER_MISSING', 'push and seed need the "pg" Postgres driver, which is not installed', {
      hint: 'Install it in your project: npm install -D pg (it is an optional peer dependency of accessnexus).',
      cause: error,
    });
  }
}

async function createPgClient(dbUrl: string): Promise<any> {
  const pgModule = await loadPgModule();

  const ClientCtor = pgModule.Client ?? pgModule.default?.Client;
  if (!ClientCtor) {
    throw new CliError('PG_DRIVER_MISSING', 'The installed "pg" package does not export Client', {
      hint: 'Reinstall it: npm install -D pg@8',
    });
  }

  const options: Record<string, unknown> = {
    connectionString: dbUrl,
    connectionTimeoutMillis: dbConnectTimeoutMs(),
  };
  if (shouldForceSsl(dbUrl)) {
    options.ssl = { rejectUnauthorized: false };
  }

  const client = new ClientCtor(options);
  try {
    await client.connect();
  } catch (error: any) {
    await client.end().catch(() => {});
    throw new CliError('DB_CONNECTION_FAILED', `Could not connect to the database (${redactUrl(dbUrl)}): ${error?.message ?? error}`, {
      hint: 'Check the URL, password and network. For Supabase use the "Session pooler" (IPv4) connection string from Dashboard → Connect; '
        + 'append ?sslmode=disable only for a local database. '
        + `Connections time out after ${options.connectionTimeoutMillis as number / 1000}s (ACCESSNEXUS_DB_CONNECT_TIMEOUT=<seconds> to change).`,
      cause: error,
    });
  }
  return client;
}

/** Hide the password in a connection string before printing it. */
function redactUrl(url: string): string {
  return url.replace(/(\/\/[^:/@]+:)[^@]*@/, '$1***@');
}

async function ensureMigrationsTable(client: any): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS public.accessnexus_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      category TEXT NOT NULL,
      checksum TEXT NOT NULL,
      hash_strategy TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      execution_time_ms INTEGER NOT NULL DEFAULT 0,
      success BOOLEAN NOT NULL DEFAULT TRUE,
      logs TEXT
    );

    ALTER TABLE public.accessnexus_migrations
      ADD COLUMN IF NOT EXISTS hash_strategy TEXT;

    CREATE INDEX IF NOT EXISTS idx_accessnexus_migrations_lookup
      ON public.accessnexus_migrations (category, filename, applied_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_accessnexus_migrations_success
      ON public.accessnexus_migrations (category, filename)
      WHERE success;

    ALTER TABLE public.accessnexus_migrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.accessnexus_migrations FORCE ROW LEVEL SECURITY;
  `;
  await client.query(sql);
}

/**
 * The SECURITY DEFINER helpers (membership checks, soft delete) run as the role
 * that pushed them and rely on it bypassing RLS; without BYPASSRLS every
 * membership-checked query recurses into its own policy and fails with
 * "stack depth limit exceeded". Supabase's `postgres` role has it.
 */
export async function assertRoleBypassesRls(client: { query(sql: string): Promise<{ rows: any[] }> }): Promise<void> {
  const { rows } = await client.query(
    'SELECT current_user AS role, (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user',
  );
  const row = rows[0];
  if (row && row.bypass === false) {
    throw new CliError('PUSH_ROLE_NO_BYPASSRLS', `The database role "${row.role}" does not bypass RLS, but the generated SECURITY DEFINER helpers (membership checks, soft delete) need it`, {
      hint: 'Nothing was applied. Connect as the "postgres" role (Supabase: Dashboard → Connect → "Session pooler" string), '
        + `or grant it: ALTER ROLE ${row.role} BYPASSRLS (run by a superuser).`,
    });
  }
}

async function acquirePushLock(client: any): Promise<void> {
  const attempt = await client.query(`SELECT pg_try_advisory_lock(hashtext('accessnexus_push_lock')) AS locked;`);
  if (attempt.rows?.[0]?.locked === true) return;
  log(`  ${paint.yellow('…')} Another accessnexus push holds the lock on this database — waiting for it to finish (Ctrl+C to abort)`);
  await client.query(`SELECT pg_advisory_lock(hashtext('accessnexus_push_lock'));`);
}

async function releasePushLock(client: any): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock(hashtext('accessnexus_push_lock'));`);
}

async function findAppliedMigration(
  client: any,
  category: string,
  filename: string,
): Promise<{ checksum: string; hashStrategy: string | null } | null> {
  const query = `
    SELECT checksum, hash_strategy
    FROM public.accessnexus_migrations
    WHERE category = $1
      AND filename = $2
      AND success = TRUE
    ORDER BY applied_at DESC
    LIMIT 1;
  `;
  const result = await client.query(query, [category, filename]);
  if (!result.rows || result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    checksum: String(row.checksum),
    hashStrategy: row.hash_strategy == null ? null : String(row.hash_strategy),
  };
}

async function recordMigration(
  client: any,
  data: {
    category: string;
    filename: string;
    checksum: string;
    executionTimeMs: number;
    success: boolean;
    logs?: string;
  },
): Promise<void> {
  const query = `
    INSERT INTO public.accessnexus_migrations (
      category,
      filename,
      checksum,
      hash_strategy,
      execution_time_ms,
      success,
      logs
    ) VALUES ($1, $2, $3, $4, $5, $6, $7);
  `;
  await client.query(query, [
    data.category,
    data.filename,
    data.checksum,
    'normalized_sql_v1',
    data.executionTimeMs,
    data.success,
    data.logs ?? null,
  ]);
}

/**
 * Re-applied policy/trigger/RPC file: move its single success row forward
 * (the unique index allows one success row per file).
 */
async function updateAppliedMigration(
  client: any,
  data: { category: string; filename: string; checksum: string; executionTimeMs: number },
): Promise<void> {
  const query = `
    UPDATE public.accessnexus_migrations
    SET checksum = $3,
        hash_strategy = 'normalized_sql_v1',
        applied_at = NOW(),
        execution_time_ms = $4,
        logs = NULL
    WHERE category = $1
      AND filename = $2
      AND success = TRUE;
  `;
  await client.query(query, [data.category, data.filename, data.checksum, data.executionTimeMs]);
}

async function refreshAppliedMigrationChecksum(
  client: any,
  category: string,
  filename: string,
  nextChecksum: string,
): Promise<void> {
  const query = `
    UPDATE public.accessnexus_migrations
    SET checksum = $3,
        hash_strategy = 'normalized_sql_v1'
    WHERE category = $1
      AND filename = $2
      AND success = TRUE;
  `;
  await client.query(query, [category, filename, nextChecksum]);
}

export interface ForeignPolicy {
  schema: string;
  table: string;
  policy: string;
  command: string;
  permissive: boolean;
}

/**
 * Tables the schema manages, as (schema, table) pairs, plus the policy names
 * AccessNexus generates for them (`<prefix>_<table>_<op>`).
 */
export function managedPolicyTargets(
  schema: SchemaDef,
  policyPrefix: string,
  defaultSchema = 'public',
): { tables: Array<{ schema: string; table: string }>; generatedNames: Set<string> } {
  const tables: Array<{ schema: string; table: string }> = [];
  const generatedNames = new Set<string>();
  for (const key of Object.keys(schema)) {
    const dot = key.indexOf('.');
    tables.push(dot === -1 ? { schema: defaultSchema, table: key } : { schema: key.slice(0, dot), table: key.slice(dot + 1) });
    for (const op of ['select', 'insert', 'update', 'delete']) generatedNames.add(`${policyPrefix}_${key}_${op}`);
  }
  return { tables, generatedNames };
}

/** RLS policies on managed tables whose name is not one AccessNexus generates. */
export async function findForeignPolicies(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  targets: ReturnType<typeof managedPolicyTargets>,
): Promise<ForeignPolicy[]> {
  if (targets.tables.length === 0) return [];
  const { rows } = await client.query(
    `SELECT p.schemaname, p.tablename, p.policyname, p.cmd, p.permissive
       FROM pg_catalog.pg_policies p
       JOIN unnest($1::text[], $2::text[]) AS t(schema_name, table_name)
         ON p.schemaname = t.schema_name AND p.tablename = t.table_name
      ORDER BY p.schemaname, p.tablename, p.policyname`,
    [targets.tables.map((t) => t.schema), targets.tables.map((t) => t.table)],
  );
  return rows
    .filter((row) => !targets.generatedNames.has(String(row.policyname)))
    .map((row) => ({
      schema: String(row.schemaname),
      table: String(row.tablename),
      policy: String(row.policyname),
      command: String(row.cmd),
      permissive: String(row.permissive).toUpperCase() === 'PERMISSIVE',
    }));
}

export interface ForeignTrigger {
  schema: string;
  table: string;
  trigger: string;
  /** The trigger function, as `regprocedure` text (e.g. `public.touch()`). */
  function: string;
}

/**
 * The function of a dropped foreign trigger. push never drops it: it reports
 * what still depends on it (pg_depend: triggers in any schema, other objects).
 * An empty `dependents` list means it is orphaned and safe to drop by hand.
 */
export interface KeptTriggerFunction {
  function: string;
  dependents: string[];
  orphaned: boolean;
}

/**
 * User triggers on managed tables whose name is not one AccessNexus generates
 * (`<prefix>_<table>_...`). After `init --db-url` the original trigger and its
 * generated copy would both fire (an audit insert or a counter runs twice).
 */
export async function findForeignTriggers(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  targets: ReturnType<typeof managedPolicyTargets>,
  policyPrefix: string,
): Promise<ForeignTrigger[]> {
  if (targets.tables.length === 0) return [];
  const { rows } = await client.query(
    `SELECT n.nspname, c.relname, t.tgname, t.tgfoid::regprocedure::text AS function
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN unnest($1::text[], $2::text[]) AS m(schema_name, table_name)
         ON n.nspname = m.schema_name AND c.relname = m.table_name
      WHERE NOT t.tgisinternal
      ORDER BY n.nspname, c.relname, t.tgname`,
    [targets.tables.map((t) => t.schema), targets.tables.map((t) => t.table)],
  );
  return rows
    .filter((row) => !String(row.tgname).startsWith(`${policyPrefix}_${row.relname}_`))
    .map((row) => ({ schema: String(row.nspname), table: String(row.relname), trigger: String(row.tgname), function: String(row.function) }));
}

/**
 * After the foreign triggers are dropped: what still depends on each of their
 * functions (pg_depend covers triggers in every schema, e.g. auth.users, and
 * other dependent objects; calls inside other function bodies are not tracked
 * by Postgres). The functions themselves are always kept.
 */
export async function describeKeptTriggerFunctions(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  triggers: ForeignTrigger[],
): Promise<KeptTriggerFunction[]> {
  const names = [...new Set(triggers.map((t) => t.function))].sort();
  if (names.length === 0) return [];
  const { rows } = await client.query(
    `SELECT f.name,
            ARRAY(SELECT DISTINCT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
                    FROM pg_catalog.pg_depend d
                   WHERE d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = f.name::regprocedure::oid
                     AND d.deptype IN ('n', 'a')
                   ORDER BY 1) AS dependents
       FROM unnest($1::text[]) AS f(name)
      WHERE pg_catalog.to_regprocedure(f.name) IS NOT NULL`,
    [names],
  );
  return rows.map((row) => {
    const dependents = (Array.isArray(row.dependents) ? row.dependents : []).map(String);
    return { function: String(row.name), dependents, orphaned: dependents.length === 0 };
  });
}

function reportKeptTriggerFunctions(kept: KeptTriggerFunction[]): void {
  if (kept.length === 0) return;
  log(paint.bold(`  Trigger functions of the dropped triggers (kept, never dropped): ${kept.length}`));
  for (const k of kept) {
    log(`    ${paint.gray('=')} ${k.function}${k.orphaned ? paint.gray(' (orphaned: nothing depends on it; drop it by hand once reviewed)') : ` (still used by: ${k.dependents.join('; ')})`}`);
  }
  log('');
}

function describeForeignTriggers(triggers: ForeignTrigger[]): string {
  return triggers.map((t) => `${t.schema}.${t.table}: "${t.trigger}"`).join('; ');
}

function reportForeignTriggers(triggers: ForeignTrigger[], willDrop: boolean): void {
  if (triggers.length === 0) return;
  log(paint.bold(`  Foreign triggers (not generated by AccessNexus) on managed tables: ${triggers.length}`));
  for (const t of triggers) log(`    ${paint.yellow('!')} ${t.schema}.${t.table}: ${t.trigger}`);
  log(`  ${paint.gray(willDrop
    ? 'These are dropped in the push transaction (--replace-foreign-triggers).'
    : 'They would fire next to the generated triggers. push refuses until you pass --replace-foreign-triggers.')}\n`);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function describeForeignPolicies(policies: ForeignPolicy[]): string {
  return policies.map((p) => `${p.schema}.${p.table}: "${p.policy}" (${p.command}${p.permissive ? '' : ', restrictive'})`).join('; ');
}

function reportForeignPolicies(policies: ForeignPolicy[], willDrop: boolean): void {
  if (policies.length === 0) return;
  log(paint.bold(`  Foreign policies (not generated by AccessNexus) on managed tables: ${policies.length}`));
  for (const p of policies) log(`    ${paint.yellow('!')} ${p.schema}.${p.table}: ${p.policy} (${p.command}${p.permissive ? '' : ', restrictive'})`);
  log(`  ${paint.gray(willDrop
    ? 'These are dropped in the push transaction (--replace-foreign-policies).'
    : 'Permissive policies OR together: these would keep granting access. push refuses until you pass --replace-foreign-policies.')}\n`);
}

async function runPush(opts: ParsedFlags): Promise<CommandResult> {
  const dryRun = opts['dry-run'] === true;
  const allowDestructive = opts['allow-destructive'] === true;
  const replaceForeign = opts['replace-foreign-policies'] === true;
  const replaceForeignTriggers = opts['replace-foreign-triggers'] === true;

  log(`\n${brand()} push...\n`);

  const { config, fileConfig } = await loadConfigWithSource(opts);
  const selection = resolveAdapterSelection(opts, config, fileConfig);
  const { dbUrl, configuredEnv } = resolveDbUrl(opts, selection);

  const plan: Array<{ key: string; title: string; files: string[] }> = [
    { key: 'migrations', title: 'Migrations', files: collectSqlFiles(config.output.migrations) },
    // RPCs before policies: policies (and triggers) may call functions declared as rpc().
    { key: 'rpcs', title: 'RPCs', files: collectSqlFiles(config.output.rpcs) },
    { key: 'policies', title: 'Policies', files: collectSqlFiles(config.output.policies) },
    { key: 'triggers', title: 'Triggers', files: collectSqlFiles(config.output.triggers) },
  ];

  const planJson = plan.map((group) => ({
    category: group.key,
    files: group.files.map((file) => relativePathFromCwd(file)),
  }));
  const migrationDestructive = plan[0].files.flatMap((file) =>
    findDestructiveStatements(relativePathFromCwd(file), readFileSync(file, 'utf-8')));
  const base: CommandResult = {
    dryRun,
    adapter: selection.adapter,
    target: selection.targetName ?? null,
    plan: planJson,
  };

  const fileCount = plan.reduce((sum, group) => sum + group.files.length, 0);
  if (fileCount === 0) {
    throw new CliError('NOTHING_TO_PUSH', `No generated SQL files found under ${config.output.dir}`, {
      hint: 'Run `npx accessnexus generate` first (or point --output / accessnexus.config.ts at the generated folder).',
      data: base,
    });
  }

  // Fail fast on a missing database URL / driver, before any output.
  if (!dryRun) {
    if (!dbUrl) throw missingDbUrlError('push', configuredEnv);
    await loadPgModule();
  }

  // Refuse to push SQL that no longer matches the schema (forgot `generate`).
  const stale = await staleGeneratedSql(config);
  if (stale.length > 0) {
    throw new CliError('GENERATED_OUT_OF_DATE', `generated SQL is out of date with ${config.schema} (${stale.length} file(s) differ)`, {
      hint: 'Run `npx accessnexus generate` (review `npx accessnexus diff` first), then push again.',
      data: { ...base, stale },
    });
  }

  const schema = await loadSchema(config.schema);
  const targets = managedPolicyTargets(
    schema,
    config.naming.policyPrefix,
    (config.adapterOptions as { schemaName?: string } | undefined)?.schemaName ?? 'public',
  );

  log(`  Adapter: ${selection.adapter}${selection.targetName ? ` (target: ${selection.targetName})` : ''}`);
  log(`  Files:   ${fileCount}`);
  for (const group of plan) {
    if (group.files.length === 0) continue;
    log(`  - ${group.title}: ${group.files.length}`);
    if (dryRun) for (const file of group.files) log(`      ${relativePathFromCwd(file)}`);
  }
  log('');

  const ctx: PushContext = {
    groups: readPushGroups(plan),
    targets,
    policyPrefix: config.naming.policyPrefix,
    replaceForeign,
    replaceForeignTriggers,
    allowDestructive,
    migrationDestructive,
    base,
  };
  const defaultSchema = (config.adapterOptions as { schemaName?: string } | undefined)?.schemaName ?? 'public';

  if (dryRun) {
    reportDestructive(migrationDestructive, 'Migration files (applied only if not yet applied)');
    // With a database: rehearse the push in a rolled-back transaction (live plan).
    let livePlan: LivePlan | null = null;
    if (dbUrl) {
      try {
        livePlan = await rehearsePush(dbUrl, ctx, defaultSchema);
      } catch (err) {
        log(`  ${paint.yellow('!')} Could not rehearse the push against the database: ${toCliError(err).message}\n`);
      }
    } else {
      log(`  ${paint.gray('No database URL: live plan and foreign policies not checked (pass --url to rehearse the push).')}\n`);
    }
    const foreignPolicies = livePlan ? livePlan.foreignPolicies : null;
    const foreignTriggers = livePlan ? livePlan.foreignTriggers : null;
    if (foreignPolicies) reportForeignPolicies(foreignPolicies, replaceForeign);
    if (foreignTriggers) reportForeignTriggers(foreignTriggers, replaceForeignTriggers);
    if (livePlan) reportLivePlan(livePlan);
    log(`  ${paint.green('✓')} Dry run — nothing was persisted\n`);
    return {
      ...base,
      destructive: migrationDestructive,
      foreignPolicies,
      foreignTriggers,
      wouldRefuse: (foreignPolicies !== null && foreignPolicies.length > 0 && !replaceForeign)
        || (foreignTriggers !== null && foreignTriggers.length > 0 && !replaceForeignTriggers)
        || (livePlan !== null && (livePlan.blockers.length > 0 || livePlan.failed !== null)),
      livePlan,
      applied: [],
      skipped: [],
      droppedPolicies: [],
      droppedTriggers: [],
      keptTriggerFunctions: [],
      seed: null,
    };
  }

  if (!dbUrl) throw missingDbUrlError('push', configuredEnv);
  if (opts.seed === true) assertSeedTargetAllowed(dbUrl, opts);

  const state = newPushState();
  const progress = () => pushProgress(base, state);

  const client = await createPgClient(dbUrl);
  let lockAcquired = false;
  let inTransaction = false;
  try {
    if (pushNeedsBypass(ctx.groups)) await assertRoleBypassesRls(client);
    await acquirePushLock(client);
    lockAcquired = true;

    // One transaction for the whole push: bookkeeping, foreign-policy drops,
    // migrations, policies, triggers and RPCs commit together or not at all.
    await client.query('BEGIN');
    inTransaction = true;
    await applyPushInTransaction(client, ctx, state, false);
    await client.query('COMMIT');
    inTransaction = false;
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors and preserve the root error
      }
    }
    if (err instanceof CliError || !inTransaction) throw err;
    const message = String((err as any)?.message ?? err);
    throw new CliError('PUSH_FAILED', `push failed and was rolled back: ${message}`, {
      hint: 'Nothing from this push was applied. Fix the cause (database state or connection), then push again.',
      data: pushRolledBack(base, state),
      cause: err,
    });
  } finally {
    if (lockAcquired) {
      try {
        await releasePushLock(client);
      } catch {
        // ignore lock release failures on shutdown path
      }
    }
    await client.end();
  }
  const { applied, skipped } = state;
  log(`${paint.green('✓ Push complete!')} Applied ${applied.length} SQL file(s), skipped ${skipped.length}.\n`);

  // The seed only runs when asked for: it writes rows (and auth.users) to the
  // database, which must never happen by accident on a production project.
  let seed: CommandResult | null = null;
  if (opts.seed === true) {
    const seedPath = config.seed;
    if (!existsSync(resolve(process.cwd(), seedPath))) {
      throw new CliError('SEED_NOT_FOUND', `--seed was passed, but the seed file ${seedPath} does not exist`, {
        hint: 'The SQL was pushed. Create accessnexus.seed.ts (or set "seed" in accessnexus.config.ts), then run `npx accessnexus seed`.',
        data: progress(),
      });
    }
    log(paint.bold('  Seed:'));
    try {
      seed = await applySeed(seedPath, config, selection, dbUrl);
    } catch (err) {
      const error = toCliError(err);
      throw new CliError(error.code, `Push succeeded, but the seed failed: ${error.message}`, {
        hint: error.hint,
        data: { ...progress(), seed: { path: seedPath, status: 'failed', message: error.message } },
        cause: err,
      });
    }
  } else if (existsSync(resolve(process.cwd(), config.seed))) {
    log(`  ${paint.gray('Seed not run (pass --seed, or run `npx accessnexus seed`).')}\n`);
  }

  return { ...progress(), seed };
}

// ---------- push core (shared by push and the live-database rehearsal) ----------

type PushFile = { path: string; sql: string };
type PushGroup = { key: string; title: string; files: PushFile[] };

interface PushContext {
  groups: PushGroup[];
  targets: ReturnType<typeof managedPolicyTargets>;
  policyPrefix: string;
  replaceForeign: boolean;
  replaceForeignTriggers: boolean;
  allowDestructive: boolean;
  migrationDestructive: DestructiveStatement[];
  base: CommandResult;
}

interface PushState {
  applied: string[];
  skipped: Array<{ path: string; reason: string }>;
  droppedPolicies: ForeignPolicy[];
  droppedTriggers: ForeignTrigger[];
  keptTriggerFunctions: KeptTriggerFunction[];
  foreignPolicies: ForeignPolicy[] | null;
  foreignTriggers: ForeignTrigger[] | null;
  /** Rehearsal only: the refusals a real push would stop at (it would apply nothing). */
  blockers: Array<{ code: string; message: string; hint?: string; details?: Record<string, unknown> }>;
}

function newPushState(): PushState {
  return { applied: [], skipped: [], droppedPolicies: [], droppedTriggers: [], keptTriggerFunctions: [], foreignPolicies: null, foreignTriggers: null, blockers: [] };
}

function pushProgress(base: CommandResult, state: PushState): CommandResult {
  return { ...base, applied: [...state.applied], skipped: [...state.skipped], droppedPolicies: [...state.droppedPolicies], droppedTriggers: [...state.droppedTriggers], keptTriggerFunctions: [...state.keptTriggerFunctions] };
}

/** After a rollback nothing from this push stays in the database. */
function pushRolledBack(base: CommandResult, state: PushState): CommandResult {
  return { ...base, applied: [], skipped: [...state.skipped], droppedPolicies: [], droppedTriggers: [], keptTriggerFunctions: [], rolledBack: [...state.applied] };
}

function readPushGroups(plan: Array<{ key: string; title: string; files: string[] }>): PushGroup[] {
  return plan.map((group) => ({
    key: group.key,
    title: group.title,
    files: group.files.map((file) => ({ path: relativePathFromCwd(file), sql: readFileSync(file, 'utf-8') })),
  }));
}

function pushNeedsBypass(groups: PushGroup[]): boolean {
  return groups.some((group) => group.files.some((file) => /SECURITY DEFINER/i.test(file.sql)));
}

/**
 * Everything push does inside its transaction. With `rehearse`, the refusals
 * (foreign policies/triggers, destructive migrations) are recorded in
 * `state.blockers` instead of thrown, and nothing is logged: the caller rolls
 * the transaction back and reports the catalog difference.
 */
async function applyPushInTransaction(client: any, ctx: PushContext, state: PushState, rehearse: boolean): Promise<void> {
  const say = rehearse ? () => {} : log;
  const refuse = (error: CliError, report: () => void) => {
    if (!rehearse) {
      report();
      throw error;
    }
    state.blockers.push({ code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
  };
  const progress = () => pushProgress(ctx.base, state);

  await ensureMigrationsTable(client);

  // Foreign policies: permissive policies OR together, so a policy we did not
  // generate keeps granting access next to ours. Never keep or drop silently.
  const foreign = await findForeignPolicies(client, ctx.targets);
  state.foreignPolicies = foreign;
  if (foreign.length > 0 && !ctx.replaceForeign) {
    refuse(new CliError('FOREIGN_POLICIES', `${foreign.length} RLS polic${foreign.length === 1 ? 'y' : 'ies'} on managed tables were not generated by AccessNexus and would keep granting access: ${describeForeignPolicies(foreign)}`, {
      hint: 'Nothing was applied. Review them (`foreignPolicies` in --json). Port any rule you still need into accessnexus.schema.ts, '
        + 'then re-run with --replace-foreign-policies to drop them in the same transaction as the push.',
      data: { ...progress(), foreignPolicies: foreign },
    }), () => reportForeignPolicies(foreign, false));
  }

  // Foreign triggers: an imported trigger and its generated copy would both fire.
  const foreignTriggers = await findForeignTriggers(client, ctx.targets, ctx.policyPrefix);
  state.foreignTriggers = foreignTriggers;
  if (foreignTriggers.length > 0 && !ctx.replaceForeignTriggers) {
    refuse(new CliError('FOREIGN_TRIGGERS', `${foreignTriggers.length} trigger(s) on managed tables were not generated by AccessNexus and would fire next to the generated ones: ${describeForeignTriggers(foreignTriggers)}`, {
      hint: 'Nothing was applied. Review them (`foreignTriggers` in --json). Port any trigger you still need into accessnexus.schema.ts '
        + '(init --db-url imports them as trigger.custom), then re-run with --replace-foreign-triggers to drop them in the same transaction as the push.',
      data: { ...progress(), foreignTriggers },
    }), () => reportForeignTriggers(foreignTriggers, false));
  }

  // Data-loss guard: look at pending migrations before applying anything.
  const migrations = ctx.groups.find((group) => group.key === 'migrations')?.files ?? [];
  const pendingDestructive: DestructiveStatement[] = [];
  for (const file of migrations) {
    if (await findAppliedMigration(client, 'migrations', file.path)) continue;
    pendingDestructive.push(...ctx.migrationDestructive.filter((statement) => statement.file === file.path));
  }
  if (pendingDestructive.length > 0 && !ctx.allowDestructive) {
    refuse(new CliError('DESTRUCTIVE_MIGRATION', `${pendingDestructive.length} pending statement(s) would delete data (DROP TABLE/COLUMN or a column type change)`, {
      hint: 'Nothing was applied. If a column or table was renamed, rename it in the schema instead of remove+add. '
        + 'When the data loss is intended (and backed up), re-run with --allow-destructive.',
      data: { ...progress(), destructive: pendingDestructive },
    }), () => reportDestructive(pendingDestructive, 'Pending migrations'));
  }

  // Drops happen only when the real push would do them (the --replace-* flags).
  if (foreign.length > 0 && ctx.replaceForeign) {
    if (!rehearse) reportForeignPolicies(foreign, true);
    for (const p of foreign) {
      await client.query(`DROP POLICY ${quoteIdent(p.policy)} ON ${quoteIdent(p.schema)}.${quoteIdent(p.table)};`);
      state.droppedPolicies.push(p);
    }
  }

  if (foreignTriggers.length > 0 && ctx.replaceForeignTriggers) {
    if (!rehearse) reportForeignTriggers(foreignTriggers, true);
    for (const t of foreignTriggers) {
      await client.query(`DROP TRIGGER ${quoteIdent(t.trigger)} ON ${quoteIdent(t.schema)}.${quoteIdent(t.table)};`);
      state.droppedTriggers.push(t);
    }
    // Dropping a trigger never drops its function: something else (a trigger
    // on auth.users, another table) may still use it. Report what remains.
    state.keptTriggerFunctions = await describeKeptTriggerFunctions(client, foreignTriggers);
    if (!rehearse) reportKeptTriggerFunctions(state.keptTriggerFunctions);
  }

  for (const group of ctx.groups) {
    if (group.files.length === 0) continue;
    say(paint.bold(`  ${group.title}:`));
    for (const file of group.files) {
      const display = file.path;
      const sql = file.sql;
      const fileChecksum = checksum(normalizeSqlForChecksum(sql));
      const appliedRecord = await findAppliedMigration(client, group.key, display);

      if (appliedRecord) {
        if (appliedRecord.checksum !== fileChecksum) {
          if (group.key === 'migrations') {
            throw new CliError('MIGRATION_DRIFT', `Migration ${display} changed after it was applied`, {
              hint: 'Nothing was applied. Applied migrations are immutable. Restore the file (e.g. `git checkout -- '
                + `${display}\`), change accessnexus.schema.ts instead and run \`npx accessnexus generate\` to get a new __changes migration.`,
              data: { ...pushRolledBack(ctx.base, state), failed: display },
            });
          }

          if (appliedRecord.hashStrategy !== 'normalized_sql_v1') {
            await refreshAppliedMigrationChecksum(client, group.key, display, fileChecksum);
            state.skipped.push({ path: display, reason: 'checksum_normalized' });
            say(`  ${paint.gray('-')} ${display} (checksum normalized)`);
            continue;
          }
        } else {
          state.skipped.push({ path: display, reason: 'already_applied' });
          say(`  ${paint.gray('-')} ${display} (already applied)`);
          continue;
        }
      }

      if (group.key === 'migrations') {
        for (const add of findNotNullColumnAdds(display, sql)) {
          const rows = await countTableRows(client, add.table);
          if (rows === null || rows === 0) continue;
          throw new CliError('NOT_NULL_ON_NON_EMPTY_TABLE',
            `${display}:${add.line} adds ${add.table}.${add.column} as NOT NULL without a default, but ${add.table} has ${rows} row(s)`, {
              hint: `Nothing was applied. Add the column as nullable ('<type>?'), backfill it with a data migration `
                + `(migrations/data/), push, then make it required. Or give it a default.`,
              data: {
                ...pushRolledBack(ctx.base, state), failed: display, sqlState: '23502',
                table: add.table, column: add.column, rows, line: add.line, statement: add.sql,
              },
            });
        }
      }

      const startedAt = Date.now();
      // A rehearsal keeps going after a failure (savepoint), so the plan can show
      // what was applied up to the statement Postgres rejected.
      if (rehearse) await client.query('SAVEPOINT accessnexus_file');
      try {
        await client.query(sql);
      } catch (error: any) {
        let where = failedStatement(sql, error?.position);
        if (rehearse) {
          await client.query('ROLLBACK TO SAVEPOINT accessnexus_file');
          // No position (constraint/data errors): replay statement by statement to find it.
          if (!where) where = await locateFailingStatement(client, sql);
          await client.query('ROLLBACK TO SAVEPOINT accessnexus_file');
        }
        const pgMessage = String(error?.message ?? 'unknown SQL error');
        throw new CliError('PUSH_FAILED', `Postgres rejected ${display}${where ? `:${where.line}` : ''}: ${pgMessage}`, {
          hint: 'The whole push was rolled back: nothing from it was applied (not the files in "rolledBack", not the foreign-policy drops). '
            + 'Fix the cause in accessnexus.schema.ts (or the database state), run `npx accessnexus generate`, then push again.',
          data: {
            ...pushRolledBack(ctx.base, state), failed: display, sqlState: error?.code ?? null,
            ...(where ? { line: where.line, statement: where.statement } : {}),
          },
          cause: error,
        });
      }
      const record = {
        category: group.key,
        filename: display,
        checksum: fileChecksum,
        executionTimeMs: Date.now() - startedAt,
      };
      if (appliedRecord) await updateAppliedMigration(client, record);
      else await recordMigration(client, { ...record, success: true });
      state.applied.push(display);
      say(`  ${paint.green('✓')} ${display}${appliedRecord ? paint.gray(' (re-applied: changed)') : ''}`);
    }
    say('');
  }
}

/** Names of the tables and functions a live plan snapshots. */
function planScope(ctx: PushContext, defaultSchema: string): SnapshotScope {
  const functions: SnapshotScope['functions'] = [];
  for (const group of ctx.groups) {
    for (const file of group.files) {
      for (const fn of functionsDefinedIn(file.sql, defaultSchema)) {
        if (!functions.some((f) => f.schema === fn.schema && f.name === fn.name)) functions.push(fn);
      }
    }
  }
  return { tables: ctx.targets.tables, functions };
}

export interface LivePlan {
  database: string;
  /** Files the push would execute (not yet applied, or changed policy/trigger/RPC files). */
  wouldApply: string[];
  skipped: Array<{ path: string; reason: string }>;
  droppedPolicies: ForeignPolicy[];
  droppedTriggers: ForeignTrigger[];
  /** Functions of the dropped triggers: kept, with what still depends on them. */
  keptTriggerFunctions: KeptTriggerFunction[];
  foreignPolicies: ForeignPolicy[];
  foreignTriggers: ForeignTrigger[];
  /** Refusals the real push stops at before applying anything. */
  blockers: Array<{ code: string; message: string; hint?: string; details?: Record<string, unknown> }>;
  /** The push would fail: the file Postgres rejected, its error and the statement. Nothing persisted. */
  failed: {
    file: string | null; code: string; message: string; sqlState: string | null;
    /** 1-based line of the rejected statement in `file`, and its text, when Postgres reports a position. */
    line: number | null; statement: string | null;
  } | null;
  changed: boolean;
  summary: { added: number; modified: number; removed: number; renamed: number };
  changes: PlanChange[];
  riskyChanges: RiskyChange[];
  persisted: false;
}

/**
 * Compute what push would change in the live database by REHEARSAL: lock,
 * BEGIN, snapshot, apply exactly what push applies, snapshot, ROLLBACK.
 */
async function rehearsePush(dbUrl: string, ctx: PushContext, defaultSchema: string): Promise<LivePlan> {
  const state = newPushState();
  const scope = planScope(ctx, defaultSchema);
  const client = await createPgClient(dbUrl);
  let lockAcquired = false;
  let failed: LivePlan['failed'] = null;
  let changes: PlanChange[] = [];
  try {
    if (pushNeedsBypass(ctx.groups)) {
      try {
        await assertRoleBypassesRls(client);
      } catch (err) {
        const error = toCliError(err);
        state.blockers.push({ code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) });
      }
    }
    const attempt = await client.query(`SELECT pg_try_advisory_lock(hashtext('accessnexus_push_lock')) AS locked;`);
    if (attempt.rows?.[0]?.locked !== true) {
      throw new CliError('PUSH_LOCKED', 'Another accessnexus push is running on this database; the plan was not computed', {
        hint: 'Nothing was touched. Wait for the other push to finish, then run the plan again.',
      });
    }
    lockAcquired = true;

    await client.query('BEGIN');
    try {
      const before = await captureSnapshot(client, scope);
      try {
        await applyPushInTransaction(client, ctx, state, true);
      } catch (err) {
        const error = toCliError(err);
        const data = (error.data ?? {}) as Record<string, unknown>;
        failed = {
          file: (data.failed as string | undefined) ?? null,
          code: error.code,
          message: error.message,
          sqlState: (data.sqlState as string | null | undefined) ?? null,
          line: (data.line as number | undefined) ?? null,
          statement: (data.statement as string | undefined) ?? null,
        };
        if (error.code === 'NOT_NULL_ON_NON_EMPTY_TABLE') {
          state.blockers.push({
            code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}),
            details: { table: data.table, column: data.column, rows: data.rows },
          });
        }
      }
      // Snapshot the same functions again, even those only reached through a
      // trigger the push drops: dropping a trigger never drops its function.
      // After a failure this is the partial plan: what applied before it.
      changes = diffSnapshots(before, await captureSnapshot(client, { ...scope, functionOids: snapshotFunctionOids(before) }));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    if (lockAcquired) await releasePushLock(client).catch(() => {});
    await client.end().catch(() => {});
  }

  return {
    database: redactUrl(dbUrl),
    // With a failure: the files applied before it (the push itself would apply none).
    wouldApply: state.applied,
    skipped: state.skipped,
    droppedPolicies: state.droppedPolicies,
    droppedTriggers: state.droppedTriggers,
    keptTriggerFunctions: state.keptTriggerFunctions,
    foreignPolicies: state.foreignPolicies ?? [],
    foreignTriggers: state.foreignTriggers ?? [],
    blockers: state.blockers,
    failed,
    changed: changes.length > 0,
    summary: summarizeChanges(changes),
    changes,
    riskyChanges: findRiskyChanges(changes),
    persisted: false,
  };
}

function reportLivePlan(plan: LivePlan): void {
  log(paint.bold(`  Live plan against ${plan.database} (rehearsed in a rolled-back transaction):\n`));
  if (plan.failed) {
    log(`  ${paint.red('✗ The push would fail:')} ${plan.failed.message}`);
    if (plan.failed.file) log(`    file: ${plan.failed.file}${plan.failed.line ? `:${plan.failed.line}` : ''}`);
    if (plan.failed.statement) log(`    statement: ${plan.failed.statement.split('\n')[0]}${plan.failed.statement.includes('\n') ? ' …' : ''}`);
    log(`  ${paint.gray('Nothing was persisted.')}\n`);
    return;
  }
  if (plan.wouldApply.length > 0) {
    log(`  Would apply ${plan.wouldApply.length} file(s), skip ${plan.skipped.length} already applied.`);
  }
  if (!plan.changed) {
    log(`  ${paint.green('✓')} No catalog changes: the database already matches what push would apply\n`);
  } else {
    log(`  ${paint.green('+')} added: ${plan.summary.added}   ${paint.yellow('~')} modified: ${plan.summary.modified}   ${paint.red('-')} removed: ${plan.summary.removed}\n`);
    for (const line of renderPlan(plan.changes, plan.riskyChanges)) log(line);
  }
  reportKeptTriggerFunctions(plan.keptTriggerFunctions);
  for (const blocker of plan.blockers) {
    log(`  ${paint.yellow('!')} push would refuse [${blocker.code}]: ${blocker.message}`);
  }
  if (plan.blockers.length > 0) log('');
}


/** Generated SQL files on disk that differ from what the current schema produces. */
async function staleGeneratedSql(config: ResolvedConfig): Promise<Array<{ path: string; status: string }>> {
  const schema = await loadSchema(config.schema);
  assertSchemaValid(schema, { schemaPath: config.schema });
  const adapter = new SupabaseAdapter({
    policyPrefix: config.naming.policyPrefix,
    ...config.adapterOptions,
  });
  const sqlConfig: ResolvedConfig = { ...config, generate: { ...config.generate, sqlOnly: true, sdkOnly: false } };
  const generated = collectGeneratedOutputs(schema, adapter, sqlConfig);
  const expected = generated.flatMap((group) => group.files);
  const changes = buildDiff(expected, collectExistingFiles(generated.map((group) => group.scope), expected));
  return changes.map((change) => ({ path: change.displayPath, status: change.status }));
}

function isHostedSupabase(dbUrl: string): boolean {
  try {
    return /(^|\.)supabase\.(co|com|in)$/i.test(new URL(dbUrl).hostname);
  } catch {
    return /supabase\.(co|com|in)/i.test(dbUrl);
  }
}

/** Seeding a hosted project (likely production) needs an explicit flag. */
function assertSeedTargetAllowed(dbUrl: string, opts: ParsedFlags): void {
  if (!isHostedSupabase(dbUrl) || opts['allow-remote-seed'] === true) return;
  throw new CliError('SEED_REMOTE_BLOCKED', `Refusing to seed a hosted Supabase database (${redactUrl(dbUrl)})`, {
    hint: 'Seeds are for local/dev databases: they upsert rows and can create auth.users. '
      + 'Point --url at a local database (supabase start), or pass --allow-remote-seed if this really is a disposable project.',
  });
}

/** Load the seed, generate its SQL and apply it in one transaction. Throws CliError on failure. */
async function applySeed(
  seedPath: string,
  config: ResolvedConfig,
  selection: { adapter: string; adapterOptions?: Record<string, unknown> },
  dbUrl: string,
): Promise<CommandResult> {
  const seedData = await loadModule(seedPath, 'Seed file', 'SEED');
  if (!seedData || typeof seedData !== 'object' || Object.keys(seedData).length === 0) {
    throw new CliError('SEED_EMPTY', `Seed file ${seedPath} exports no data`, {
      hint: 'Default-export defineSeed(schema, { profiles: [{ ... }] }).',
    });
  }

  const schema = await loadSchema(config.schema);
  const adapter = new SupabaseAdapter({
    policyPrefix: config.naming.policyPrefix,
    ...config.adapterOptions,
    ...selection.adapterOptions,
  });
  const generated = adapter.generateSeed(schema, seedData, { authPassword: process.env.ACCESSNEXUS_SEED_PASSWORD });
  if (generated.length === 0) return { path: seedPath, status: 'skipped', message: 'no seed SQL generated', authUsers: 0 };

  const seedSql = generated[0].content;
  const authUsers = countSeedAuthUsers(seedSql);
  warnSeedAuthUsers(authUsers);

  const client = await createPgClient(dbUrl);
  const startedAt = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(seedSql);
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw new CliError('SEED_FAILED', `Postgres rejected the seed: ${err.message}`, {
      hint: 'The seed was rolled back. Check that `push` ran first and that the rows match the schema (unique keys, references).',
      cause: err,
    });
  } finally {
    await client.end();
  }
  const durationMs = Date.now() - startedAt;
  log(`  ${paint.green('✓')} Seed applied (${seedPath}) in ${durationMs}ms\n`);
  return { path: seedPath, status: 'applied', authUsers, durationMs };
}

function countSeedAuthUsers(seedSql: string): number {
  return (seedSql.match(/^INSERT INTO auth\.users /gm) ?? []).length;
}

function warnSeedAuthUsers(count: number): void {
  if (count === 0) return;
  log(`  ${paint.yellow('!')} The seed creates ${count} auth.users row(s) (email confirmed). `
    + (process.env.ACCESSNEXUS_SEED_PASSWORD
      ? 'Their password is ACCESSNEXUS_SEED_PASSWORD — use this only on local/dev databases.'
      : 'Their password is random and unknown (set ACCESSNEXUS_SEED_PASSWORD to log in as them locally).'));
}

async function runSeed(opts: ParsedFlags): Promise<CommandResult> {
  const dryRun = opts['dry-run'] === true;

  log(`\n${brand()} seeding...\n`);

  const { config, fileConfig } = await loadConfigWithSource(opts);
  const seedPath = (opts.seed as string) || config.seed || DEFAULT_SEED_PATH;

  const schema = await loadSchema(config.schema);

  const absoluteSeed = resolve(process.cwd(), seedPath);
  if (!existsSync(absoluteSeed)) {
    throw new CliError('SEED_NOT_FOUND', `Seed file not found: ${seedPath}`, {
      hint: 'Create accessnexus.seed.ts with `export default defineSeed(schema, { table: [rows] })`, pass --seed <path>, or set "seed" in accessnexus.config.ts.',
    });
  }
  const seedData = await loadModule(seedPath, 'Seed file', 'SEED');
  if (!seedData || typeof seedData !== 'object' || Object.keys(seedData).length === 0) {
    throw new CliError('SEED_EMPTY', `Seed file ${seedPath} exports no data`, {
      hint: 'Default-export defineSeed(schema, { profiles: [{ ... }] }).',
    });
  }

  const selection = resolveAdapterSelection(opts, config, fileConfig);
  const { dbUrl, configuredEnv } = resolveDbUrl(opts, selection);

  const adapter = new SupabaseAdapter({
    policyPrefix: config.naming.policyPrefix,
    ...config.adapterOptions,
    ...selection.adapterOptions,
  });

  const generated = adapter.generateSeed(schema, seedData, { authPassword: process.env.ACCESSNEXUS_SEED_PASSWORD });
  if (generated.length === 0) {
    log(`  ${paint.yellow('!')} No seed data generated.`);
    return { dryRun, seedPath, applied: false, rows: 0 };
  }

  const seedSql = generated[0].content;
  const checksumVal = checksum(normalizeSqlForChecksum(seedSql));
  const rows = Object.values(seedData as Record<string, unknown[]>).reduce(
    (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  );
  const authUsers = countSeedAuthUsers(seedSql);

  log(`  Seed file: ${seedPath}`);
  log(`  Target:    ${selection.adapter} (${dbUrl ? 'DB URL provided' : 'No DB URL'})`);
  log(`  Checksum:  ${checksumVal.substring(0, 8)}`);
  log('');
  warnSeedAuthUsers(authUsers);

  const base = { dryRun, seedPath, checksum: checksumVal, rows, authUsers };

  if (dryRun) {
    log(`  ${paint.cyan('--dry-run')}: Seed SQL preview:\n`);
    log(seedSql);
    return { ...base, applied: false, sql: seedSql };
  }

  if (!dbUrl) throw missingDbUrlError('seed', configuredEnv);
  assertSeedTargetAllowed(dbUrl, opts);

  const client = await createPgClient(dbUrl);
  try {
    log(`  ${paint.cyan('Running seed...')}`);
    const startedAt = Date.now();

    await client.query('BEGIN');
    await client.query(seedSql);
    await client.query('COMMIT');

    const duration = Date.now() - startedAt;
    log(`  ${paint.green('✓')} Seed applied successfully in ${duration}ms`);
    return { ...base, applied: true, durationMs: duration };
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    throw new CliError('SEED_FAILED', `Postgres rejected the seed: ${err.message}`, {
      hint: 'The seed was rolled back. Check that `push` ran first and that the rows match the schema (unique keys, references).',
      cause: err,
    });
  } finally {
    await client.end();
  }
}

// ---- Generation helpers ----

type OutputCategory = 'migrations' | 'policies' | 'triggers' | 'rpcs' | 'sdk' | 'functions';

type GeneratedGroup = {
  title: string;
  category: OutputCategory;
  outputBase: string;
  files: ExpectedFile[];
  scope: OutputScope;
};

type WrittenFile = { path: string; category: OutputCategory; status: 'created' | 'updated' | 'unchanged' };

function collectGeneratedOutputs(schema: SchemaDef, adapter: SupabaseAdapter, config: ResolvedConfig): GeneratedGroup[] {
  const groups: GeneratedGroup[] = [];

  if (!config.generate.sdkOnly) {
    const migrations = resolveVersionedMigrations(schema, adapter, config.output.migrations);
    groups.push({
      title: 'Migrations',
      category: 'migrations',
      outputBase: config.output.migrations,
      files: toExpectedFiles(config.output.migrations, migrations),
      scope: { baseDir: config.output.migrations, allowedExtensions: ['.sql', '.json'], trackRemovals: false },
    });

    const policies = adapter.generatePolicies(schema);
    groups.push({
      title: 'SQL Policies',
      category: 'policies',
      outputBase: config.output.policies,
      files: toExpectedFiles(config.output.policies, policies),
      scope: { baseDir: config.output.policies, allowedExtensions: ['.sql'] },
    });

    const triggers = adapter.generateTriggers(schema);
    groups.push({
      title: 'Triggers',
      category: 'triggers',
      outputBase: config.output.triggers,
      files: toExpectedFiles(config.output.triggers, triggers),
      scope: { baseDir: config.output.triggers, allowedExtensions: ['.sql'] },
    });

    const rpcs = adapter.generateRpcs(schema);
    groups.push({
      title: 'RPCs',
      category: 'rpcs',
      outputBase: config.output.rpcs,
      files: toExpectedFiles(config.output.rpcs, rpcs),
      scope: { baseDir: config.output.rpcs, allowedExtensions: ['.sql'] },
    });
  }

  if (!config.generate.sqlOnly) {
    const sdk = adapter.generateClient(schema);
    groups.push({
      title: 'Typed SDK',
      category: 'sdk',
      outputBase: config.output.sdk,
      files: toExpectedFiles(config.output.sdk, sdk),
      // The SDK folder also holds hand-written/init wrappers (browser.ts, server.ts,
      // index.ts) — never report those as "removed".
      scope: { baseDir: config.output.sdk, allowedExtensions: ['.ts'], trackRemovals: false },
    });

    const functions = adapter.generateEdgeFunctions(schema);
    if (functions.length > 0) {
      groups.push({
        title: 'Edge Functions',
        category: 'functions',
        outputBase: config.output.functions,
        files: toExpectedFiles(config.output.functions, functions),
        // Function folders are the user's code: only the files we write are compared.
        scope: { baseDir: config.output.functions, allowedExtensions: ['.ts'], trackRemovals: false },
      });
      const toml = edgeFunctionsConfigToml(adapter, schema, config.output.functions);
      if (toml) {
        groups.push({
          title: 'Supabase config',
          category: 'functions',
          outputBase: dirname(toml.absolutePath),
          files: [toml],
          scope: { baseDir: dirname(toml.absolutePath), allowedExtensions: ['.toml'], trackRemovals: false },
        });
      }
    }
  }

  return groups;
}

/**
 * Write generated files. A file whose content only differs in the volatile
 * `-- Generated at:` header line is left untouched (no git churn).
 */
function writeGeneratedOutputs(groups: GeneratedGroup[]): WrittenFile[] {
  const written: WrittenFile[] = [];
  for (const group of groups) {
    if (group.files.length === 0) continue;
    log(paint.bold(`  ${group.title}:`));
    for (const file of group.files) {
      const existing = existsSync(file.absolutePath) ? readFileSync(file.absolutePath, 'utf-8') : undefined;
      let status: WrittenFile['status'];
      if (existing !== undefined && stripVolatileHeader(existing) === stripVolatileHeader(file.content)) {
        status = 'unchanged';
      } else {
        mkdirSync(dirname(file.absolutePath), { recursive: true });
        writeFileSync(file.absolutePath, file.content, 'utf-8');
        status = existing === undefined ? 'created' : 'updated';
      }
      written.push({ path: file.displayPath, category: group.category, status });
      const mark = status === 'unchanged' ? paint.gray('=') : paint.green('✓');
      log(`  ${mark} ${file.displayPath}${status === 'unchanged' ? paint.gray(' (unchanged)') : ''}`);
    }
    log('');
  }
  return written;
}

/** Destructive statements in migration files that are new or changed in this run. */
function destructiveInChangedMigrations(groups: GeneratedGroup[], changedPaths: Set<string>): DestructiveStatement[] {
  const migrations = groups.find((group) => group.category === 'migrations');
  if (!migrations) return [];
  return migrations.files
    .filter((file) => file.displayPath.endsWith('.sql') && changedPaths.has(file.displayPath))
    .flatMap((file) => findDestructiveStatements(file.displayPath, file.content));
}

function reportDestructive(statements: DestructiveStatement[], label: string): void {
  if (statements.length === 0) return;
  log(`  ${paint.red('⚠ Data loss:')} ${label} contains ${statements.length} destructive statement(s):`);
  for (const statement of statements) log(`    ${statement.file}:${statement.line}  ${statement.sql}`);
  log(`  ${paint.gray('push refuses these until you pass --allow-destructive. A rename? Rename in the schema instead of remove + add.')}\n`);
}

function toExpectedFiles(outputBase: string, files: GeneratedOutput[]): ExpectedFile[] {
  // `overwrite: false` (scaffolds): created when missing, never compared or replaced after.
  return files.filter((file) => file.overwrite !== false || !existsSync(resolve(outputBase, file.path))).map((file) => {
    const absolutePath = resolve(outputBase, file.path);
    const displayPath = relativePathFromCwd(absolutePath);
    return {
      absolutePath,
      displayPath,
      content: file.content,
    };
  });
}

function relativePathFromCwd(absolutePath: string): string {
  return relative(process.cwd(), absolutePath).replaceAll('\\', '/');
}

/** Path for messages: relative when inside cwd, absolute otherwise. */
function prettyPath(absolutePath: string): string {
  const rel = relativePathFromCwd(absolutePath);
  return rel === '' || rel.startsWith('..') ? absolutePath : rel;
}

/**
 * `supabase/config.toml` (next to the functions folder) with the AccessNexus
 * block of `[functions.<name>] verify_jwt = ...` tables replaced. Only when the
 * file exists (`supabase init` creates it). A `[functions.<name>]` table the
 * user wrote outside the block is left alone (Supabase would reject a duplicate),
 * with a note in the block.
 */
function edgeFunctionsConfigToml(adapter: SupabaseAdapter, schema: SchemaDef, functionsDir: string): ExpectedFile | null {
  const entries = adapter.edgeFunctionsConfigToml(schema);
  if (!entries) return null;
  const absolutePath = resolve(functionsDir, '..', 'config.toml');
  if (!existsSync(absolutePath)) return null;
  const original = readFileSync(absolutePath, 'utf-8');
  const begin = original.indexOf(EDGE_FUNCTIONS_TOML_BEGIN);
  const endMarker = begin === -1 ? -1 : original.indexOf(EDGE_FUNCTIONS_TOML_END, begin);
  const outside = begin === -1 || endMarker === -1
    ? original
    : original.slice(0, begin) + original.slice(endMarker + EDGE_FUNCTIONS_TOML_END.length);

  const block: string[] = [EDGE_FUNCTIONS_TOML_BEGIN];
  for (const { name, verifyJwt } of entries) {
    const header = new RegExp(`^\\s*\\[functions\\.(?:${name}|"${name}")\\]\\s*$`, 'm');
    if (header.test(outside)) {
      block.push(`# ${name}: [functions.${name}] is already set above; set verify_jwt = ${verifyJwt} there.`);
      continue;
    }
    block.push(`[functions.${name}]`, `verify_jwt = ${verifyJwt}`, '');
  }
  if (block[block.length - 1] === '') block.pop();
  block.push(EDGE_FUNCTIONS_TOML_END);
  const blockText = block.join('\n');

  let content: string;
  if (begin !== -1 && endMarker !== -1) {
    content = original.slice(0, begin) + blockText + original.slice(endMarker + EDGE_FUNCTIONS_TOML_END.length);
  } else {
    content = `${original.replace(/\s*$/, '')}\n\n${blockText}\n`;
  }
  return { absolutePath, displayPath: relativePathFromCwd(absolutePath), content };
}

/** NOT_NULL_COLUMN_ADDED warnings for the changed migration files. */
function notNullColumnWarnings(groups: GeneratedGroup[], changedPaths: Set<string>): SchemaIssue[] {
  const migrations = groups.find((group) => group.category === 'migrations');
  if (!migrations) return [];
  return migrations.files
    .filter((file) => file.absolutePath.endsWith('.sql') && changedPaths.has(file.displayPath))
    .flatMap((file) => findNotNullColumnAdds(pendingMigrationName(file.displayPath, file.absolutePath), file.content))
    .map((add) => ({
      severity: 'warning' as const,
      code: 'NOT_NULL_COLUMN_ADDED',
      path: `${add.table}.columns.${add.column}`,
      message: `${add.file}:${add.line} adds ${add.table}.${add.column} as NOT NULL without a default: push fails if ${add.table} has rows`,
      hint: `Give it a default, or add it in two steps: make it nullable ('<type>?') with a backfill data migration, `
        + `push, then make it required (see the "required column on a table with data" recipe).`,
    }));
}

function reportMigrationWarnings(warnings: SchemaIssue[]): void {
  for (const w of warnings) log(`  ${paint.yellow('⚠')} ${w.message}\n    ${paint.gray(w.hint ?? '')}`);
  if (warnings.length > 0) log('');
}

/** Rows in `table` (public), or null when it does not exist yet. */
async function countTableRows(client: any, table: string): Promise<number | null> {
  const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  if (exists.rows?.[0]?.ok !== true) return null;
  const res = await client.query(`SELECT count(*)::int AS n FROM public.${quoteIdent(table)}`);
  return res.rows?.[0]?.n ?? 0;
}

/** The statement around Postgres' 1-based error `position` in `sql`, with its line. */
function failedStatement(sql: string, position: unknown): { line: number; statement: string } | null {
  const pos = Number(position);
  if (!Number.isFinite(pos) || pos < 1 || pos > sql.length + 1) return null;
  const offset = pos - 1;
  const line = sql.slice(0, offset).split('\n').length;
  // The statement (dollar-quoted bodies kept whole) that contains the offset.
  let cursor = 0;
  for (const stmt of splitSqlStatements(sql)) {
    const start = sql.indexOf(stmt.sql, cursor);
    if (start === -1) break;
    const end = start + stmt.sql.length;
    if (offset >= start && offset <= end) return { line, statement: stmt.sql };
    cursor = end;
  }
  return null;
}

/**
 * Split SQL into statements with their 1-based start line. Respects quotes,
 * dollar-quoted bodies ($$ / $tag$) and comments, so function bodies stay whole.
 */
export function splitSqlStatements(sql: string): Array<{ line: number; sql: string }> {
  const out: Array<{ line: number; sql: string }> = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    let text = sql.slice(start, end);
    let offset = start;
    // Leading blank lines and -- comment lines belong to no statement.
    for (;;) {
      const m = /^(\s*--[^\n]*\n|\s+)/.exec(text);
      if (!m || m[0].length === 0) break;
      offset += m[0].length;
      text = text.slice(m[0].length);
    }
    const body = text.trim();
    if (body.replace(/--[^\n]*/g, '').trim() !== '') {
      out.push({ line: sql.slice(0, offset).split('\n').length, sql: body });
    }
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) { j += 2; continue; }
        if (sql[j] === ch) break;
        j += 1;
      }
      i = j + 1;
    } else if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
      } else {
        i += 1;
      }
    } else if (ch === ';') {
      push(i + 1);
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  push(sql.length);
  return out;
}

/** Inside a savepoint: run `sql` statement by statement; the first one that fails. */
async function locateFailingStatement(client: any, sql: string): Promise<{ line: number; statement: string } | null> {
  for (const stmt of splitSqlStatements(sql)) {
    await client.query('SAVEPOINT accessnexus_stmt');
    try {
      await client.query(stmt.sql);
      await client.query('RELEASE SAVEPOINT accessnexus_stmt');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT accessnexus_stmt');
      return { line: stmt.line, statement: stmt.sql };
    }
  }
  return null;
}

/** `migration data <name>`: an empty data migration, ordered after every existing migration. */
async function runMigrationData(opts: ParsedFlags): Promise<CommandResult> {
  const name = (opts._migration as unknown as { name: string }).name;
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new CliError('INVALID_FLAG_VALUE', `Data migration name "${name}" must be lowercase snake_case`, {
      hint: 'Example: backfill_task_org.',
    });
  }
  const { config } = await loadConfigWithSource(opts);
  const dir = resolve(config.output.migrations);
  const dataDir = join(dir, 'data');
  const existing = [...collectSqlFiles(dir)].map((f) => /^(\d{14})__/.exec(basename(f))?.[1]).filter((t): t is string => !!t);
  let stamp = timestampNow();
  const latest = existing.sort().at(-1);
  if (latest && stamp <= latest) stamp = bumpTimestamp(latest);
  const file = join(dataDir, `${stamp}__${name}.sql`);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, [
    `-- Data migration ${name}: written by you, applied once by \`accessnexus push\`, in timestamp`,
    `-- order with the schema migrations (after ${latest ? `${latest}__*` : 'none yet'}).`,
    `-- It runs as the push user (RLS bypassed) inside the push transaction, and is recorded in`,
    `-- public.accessnexus_migrations: never edit it after it was applied (MIGRATION_DRIFT).`,
    `-- Typical use: backfill a column added as nullable, before a later migration makes it NOT NULL.`,
    '',
    `-- UPDATE public.tasks SET org_id = ... WHERE org_id IS NULL;`,
    '',
  ].join('\n'));
  const display = relativePathFromCwd(file);
  log(`\n  ${paint.green('✓')} Created ${display}\n`);
  return { created: display };
}

function timestampNow(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

function bumpTimestamp(stamp: string): string {
  const d = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12), +stamp.slice(12, 14) + 1));
  return timestampNow(d);
}

// ---- test-db ----

function docker(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('docker', args, { encoding: 'utf-8', ...(input !== undefined ? { input } : {}) });
  if (res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new CliError('DOCKER_NOT_FOUND', 'test-db needs Docker, and the docker command was not found', {
      hint: 'Install Docker (or start Docker Desktop), then run the command again.',
    });
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function runTestDb(opts: ParsedFlags): Promise<CommandResult> {
  const action = opts._action as unknown as 'up' | 'down';
  const name = (opts.name as string | undefined) ?? 'accessnexus-test-db';
  const port = Number((opts.port as string | undefined) ?? '55433');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError('INVALID_FLAG_VALUE', `--port must be a TCP port, got "${String(opts.port)}"`);
  }
  if (action === 'down') {
    const res = docker(['rm', '-f', name]);
    log(`\n  ${res.status === 0 ? paint.green('✓') : paint.gray('-')} ${res.status === 0 ? `Removed ${name}` : `${name} was not running`}\n`);
    return { action, container: name, removed: res.status === 0 };
  }

  const image = (opts.image as string | undefined) ?? 'ghcr.io/supabase/postgres:15.19.0.007';
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  log(`\n${brand()} test-db up (${image})...\n`);
  const running = docker(['ps', '-q', '--filter', `name=^${name}$`]).stdout.trim() !== '';
  if (!running && await portInUse(port)) {
    throw new CliError('TEST_DB_PORT_IN_USE', `Port ${port} is already in use`, {
      hint: `Pick another one with --port (e.g. --port ${port + 1}), or stop what listens on ${port}.`,
    });
  }
  if (!running) {
    const run = docker(['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=postgres', '-p', `${port}:5432`, image]);
    if (run.status !== 0) {
      throw new CliError('TEST_DB_START_FAILED', `docker run failed: ${run.stderr.trim().split('\n').pop() ?? 'unknown error'}`, {
        hint: `Is port ${port} free (--port) and is ${name} not used by another container (--name)?`,
      });
    }
  }
  // The image runs its own init scripts before accepting supabase_admin.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    // Ready when the image's init scripts are done (they create the realtime schema
    // and the supabase_realtime publication last).
    const probe = docker(['exec', name, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-tAc',
      "SELECT to_regnamespace('realtime') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')"]);
    ready = probe.status === 0 && probe.stdout.trim() === 't';
    if (!ready) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) {
    throw new CliError('TEST_DB_START_FAILED', `${name} did not become ready within 2 minutes`, {
      hint: `Check \`docker logs ${name}\`.`,
    });
  }
  // The image restarts Postgres at the end of its init: wait until connections
  // from the host succeed several times in a row before touching it.
  await waitForStableConnection(url, name);
  const standins = docker(['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'], TEST_DB_STANDINS_SQL);
  if (standins.status !== 0) {
    throw new CliError('TEST_DB_START_FAILED', `Preparing ${name} failed: ${standins.stderr.trim()}`);
  }
  log(`  ${paint.green('✓')} ${name} ready: ${url}`);
  log(`  ${paint.gray('auth.uid()/auth.jwt() read request.jwt.claims; auth.users.email_confirmed_at, realtime.messages ready.')}\n`);

  let push: CommandResult | null = null;
  if (opts.push === true) {
    push = await runPush({ ...opts, url, _action: undefined } as unknown as ParsedFlags);
  }
  return { action, container: name, url, image, push };
}

/**
 * The schema path behind a rejected statement: `rpcs.<name>` for a function of
 * rpcs.sql, `<table>.triggers[<i>]` for a trigger function, `<table>.policies.<op>`
 * for a policy, else the file.
 */
function schemaPathOfStatement(file: string | null, statement: string | null, schema: SchemaDef, prefix: string): string {
  const text = statement ?? '';
  const fn = /FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/i.exec(text)?.[1];
  const rpcs = ((schema as any).__rpcs ?? {}) as Record<string, unknown>;
  if (fn && fn in rpcs) return `rpcs.${fn}`;
  for (const [tableName, def] of Object.entries(schema)) {
    const triggers = (def.triggers ?? []) as Array<{ kind: string; name?: string; column?: string }>;
    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      const suffix = t.name ?? (t.kind === 'updated_at' ? 'updated_at' : t.kind === 'lock_columns' ? 'lock_columns' : undefined);
      if (fn && suffix && fn === `${prefix}_${tableName}_${suffix}_fn`) return `${tableName}.triggers[${i}]`;
    }
    const policy = new RegExp(`POLICY\\s+"${prefix}_${tableName}_(select|insert|update|delete)"`, 'i').exec(text);
    if (policy) return `${tableName}.policies.${policy[1].toLowerCase()}`;
  }
  return file ?? '(generated SQL)';
}

/**
 * A schema outside the project (e.g. `--schema /tmp/old.schema.ts`) cannot
 * resolve `accessnexus` from its own folder: point those imports at the package
 * this CLI runs from. Imports that do resolve locally are left alone.
 */
export function linkOwnPackage(code: string, sourceDir: string): string {
  if (!/["']accessnexus(?:\/[a-z/]+)?["']/.test(code)) return code;
  const local = createRequire(join(sourceDir, 'noop.js'));
  const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ownEntry = (specifier: string): string | null => {
    const sub = specifier.slice('accessnexus'.length).replace(/^\//, '');
    const rel = sub === '' ? 'dist/index.js' : `dist/${sub}/index.js`;
    const file = join(ownRoot, rel);
    return existsSync(file) ? pathToFileURL(file).href : null;
  };
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(accessnexus(?:\/[a-z/]+)?)\2/g, (match, lead: string, quote: string, specifier: string) => {
    try {
      local.resolve(specifier);
      return match;
    } catch {
      const target = ownEntry(specifier);
      return target ? `${lead}${quote}${target}${quote}` : match;
    }
  });
}

/** Is something listening on 127.0.0.1:<port>? */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('timeout', () => { socket.destroy(); resolvePort(false); });
    socket.once('error', () => resolvePort(false));
  });
}

/**
 * Connect from the host until 3 consecutive attempts succeed (up to 90 s): the
 * supabase/postgres image restarts the server after its init scripts, so a first
 * success can be followed by "Connection terminated unexpectedly" / ECONNREFUSED.
 */
async function waitForStableConnection(url: string, name: string): Promise<void> {
  let pgModule: any;
  try {
    const moduleName = 'pg';
    pgModule = await import(moduleName);
  } catch {
    return; // no pg driver: the docker probe above is all we can do
  }
  const Client = pgModule.Client ?? pgModule.default?.Client;
  const deadline = Date.now() + 90_000;
  let streak = 0;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      streak += 1;
    } catch {
      streak = 0;
    } finally {
      await client.end().catch(() => {});
    }
    if (streak >= 3) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new CliError('TEST_DB_START_FAILED', `${name} did not accept stable connections within 90 seconds`, {
    hint: `Check \`docker logs ${name}\`, then run \`npx accessnexus test-db up\` again.`,
  });
}

/**
 * A migration `generate` has not written yet gets a new timestamp on every run:
 * name it `<pending>__<suffix>.sql` in messages and plans until it exists.
 */
function pendingMigrationName(display: string, absolute: string): string {
  if (existsSync(absolute)) return display;
  return display.replace(/(^|\/)\d{14}__([^/]+\.sql)$/, '$1<pending>__$2');
}
