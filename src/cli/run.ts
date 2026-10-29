// ============================================
// AccessNexus CLI - command implementations
// Entry point: ./index.ts (the `accessnexus` bin) calls runCli(argv).
//
// Contract (documented in llms.txt):
//   - every command is non-interactive unless stdin is a TTY;
//   - `--json` prints exactly one JSON object on stdout;
//   - exit 0 = ok, 1 = user-fixable error, 2 = internal error.
// ============================================

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SupabaseAdapter } from '../adapters/supabase/adapter.js';
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
import { findDestructiveStatements, type DestructiveStatement } from './destructive.js';
import { resolveVersionedMigrations } from './migrations.js';
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

const DEFAULT_SCHEMA_PATH = './accessnexus.schema.ts';
const DEFAULT_SEED_PATH = './accessnexus.seed.ts';
const CONFIG_FILES = ['accessnexus.config.ts', 'accessnexus.config.js', 'accessnexus.config.mjs'];

type CommandName = 'init' | 'generate' | 'diff' | 'push' | 'seed' | 'validate';
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
      check: { kind: 'boolean', description: 'Exit 1 when generated files are out of date (for CI)' },
    },
    examples: ['npx accessnexus diff', 'npx accessnexus diff --json', 'npx accessnexus diff --check'],
  },
  validate: {
    summary: 'Check the schema for errors without writing anything',
    flags: { schema: SCHEMA_FLAG },
    examples: ['npx accessnexus validate', 'npx accessnexus validate --json'],
  },
  push: {
    summary: 'Apply the generated SQL to the database (refuses stale output and unconfirmed data loss)',
    flags: {
      ...DB_FLAGS,
      output: OUTPUT_FLAGS.output,
      prefix: OUTPUT_FLAGS.prefix,
      schema: SCHEMA_FLAG,
      'allow-destructive': { kind: 'boolean', description: 'Apply pending migrations that DROP tables/columns or change column types' },
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
    const flags = parseFlags(argv.slice(1), COMMANDS[name].flags, name);
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
  }
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
  edit accessnexus.schema.ts → validate --json → diff --json (review SQL) → generate --json → push --dry-run → push

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
    code = result.outputFiles[0].text;
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

  log(`${paint.green('✓ Done!')} ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged\n`);

  return {
    schemaPath: config.schema,
    mode: summary.mode,
    files,
    destructive,
    summary: { ...counts, files: files.length, tables: summary.tables.length },
    warnings,
  };
}

async function runDiff(opts: ParsedFlags): Promise<CommandResult> {
  log(`\n${brand()} diff...\n`);

  const { config } = await loadConfigWithSource(opts);
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

  const summary = { added: 0, modified: 0, removed: 0 };
  for (const change of changes) summary[change.status] += 1;

  const destructive = destructiveInChangedMigrations(
    generated,
    new Set(changes.filter((change) => change.status !== 'removed').map((change) => change.displayPath)),
  );

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
    warnings,
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

  if (opts.check === true && changes.length > 0) {
    throw new CliError('GENERATED_OUT_OF_DATE', `${changes.length} generated file(s) are out of date`, {
      hint: 'Run `npx accessnexus generate` and commit the result.',
      data: result,
    });
  }

  return result;
}

async function runValidate(opts: ParsedFlags): Promise<CommandResult> {
  log(`\n${brand()} validating...\n`);

  const { config } = await loadConfigWithSource(opts);
  const schema = await loadSchema(config.schema);
  const summary = summarizeSchema(schema);
  const base = { schemaPath: config.schema, ...summary };

  const warnings = assertSchemaValid(schema, base);

  log(`  ${paint.green('✓')} Schema is valid — ${summary.tables.length} tables (${summary.mode} mode)\n`);
  for (const t of summary.tables) {
    const lock = t.rls ? paint.green('RLS') : paint.yellow('no RLS');
    log(`  ${t.name} (${t.columns} columns, ${lock}${t.policies.length ? `: ${t.policies.join('/')}` : ''})`);
  }
  if (summary.rpcs.length > 0) log(`\n  RPCs: ${summary.rpcs.join(', ')}`);
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
  const dbUrl = (opts.url as string | undefined)
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

  return files.sort((a, b) => a.localeCompare(b));
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

async function ensureUuidCompatibility(client: any): Promise<void> {
  const sql = `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    DO $accessnexus$
    BEGIN
      IF to_regprocedure('public.uuid_generate_v7()') IS NULL THEN
        CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
        RETURNS uuid
        LANGUAGE sql
        VOLATILE
        SET search_path = pg_catalog
        AS $fn$
          SELECT gen_random_uuid();
        $fn$;
      END IF;
    END
    $accessnexus$;
    ALTER FUNCTION public.uuid_generate_v7() SET search_path = pg_catalog;
  `;
  await client.query(sql);
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

async function runPush(opts: ParsedFlags): Promise<CommandResult> {
  const dryRun = opts['dry-run'] === true;
  const allowDestructive = opts['allow-destructive'] === true;

  log(`\n${brand()} push...\n`);

  const { config, fileConfig } = await loadConfigWithSource(opts);
  const selection = resolveAdapterSelection(opts, config, fileConfig);
  const { dbUrl, configuredEnv } = resolveDbUrl(opts, selection);

  const plan: Array<{ key: string; title: string; files: string[] }> = [
    { key: 'migrations', title: 'Migrations', files: collectSqlFiles(config.output.migrations) },
    { key: 'policies', title: 'Policies', files: collectSqlFiles(config.output.policies) },
    { key: 'triggers', title: 'Triggers', files: collectSqlFiles(config.output.triggers) },
    { key: 'rpcs', title: 'RPCs', files: collectSqlFiles(config.output.rpcs) },
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

  log(`  Adapter: ${selection.adapter}${selection.targetName ? ` (target: ${selection.targetName})` : ''}`);
  log(`  Files:   ${fileCount}`);
  for (const group of plan) {
    if (group.files.length === 0) continue;
    log(`  - ${group.title}: ${group.files.length}`);
    if (dryRun) for (const file of group.files) log(`      ${relativePathFromCwd(file)}`);
  }
  log('');

  if (dryRun) {
    reportDestructive(migrationDestructive, 'Migration files (applied only if not yet applied)');
    log(`  ${paint.green('✓')} Dry run — execution skipped\n`);
    return { ...base, destructive: migrationDestructive, applied: [], skipped: [], seed: null };
  }

  if (!dbUrl) throw missingDbUrlError('push', configuredEnv);
  if (opts.seed === true) assertSeedTargetAllowed(dbUrl, opts);


  const applied: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const progress = () => ({ ...base, applied: [...applied], skipped: [...skipped] });

  const client = await createPgClient(dbUrl);
  let lockAcquired = false;
  try {
    const needsBypass = plan.some((group) => group.files.some((file) => /SECURITY DEFINER/i.test(readFileSync(file, 'utf-8'))));
    if (needsBypass) await assertRoleBypassesRls(client);
    await acquirePushLock(client);
    lockAcquired = true;
    await ensureMigrationsTable(client);
    await ensureUuidCompatibility(client);

    // Data-loss guard: look at pending migrations before applying anything.
    const pendingDestructive: DestructiveStatement[] = [];
    for (const file of plan[0].files) {
      const display = relativePathFromCwd(file);
      if (await findAppliedMigration(client, 'migrations', display)) continue;
      pendingDestructive.push(...migrationDestructive.filter((statement) => statement.file === display));
    }
    if (pendingDestructive.length > 0 && !allowDestructive) {
      reportDestructive(pendingDestructive, 'Pending migrations');
      throw new CliError('DESTRUCTIVE_MIGRATION', `${pendingDestructive.length} pending statement(s) would delete data (DROP TABLE/COLUMN or a column type change)`, {
        hint: 'Nothing was applied. If a column or table was renamed, rename it in the schema instead of remove+add. '
          + 'When the data loss is intended (and backed up), re-run with --allow-destructive.',
        data: { ...progress(), destructive: pendingDestructive },
      });
    }

    for (const group of plan) {
      if (group.files.length === 0) continue;
      log(paint.bold(`  ${group.title}:`));
      for (const file of group.files) {
        const display = relativePathFromCwd(file);
        const sql = readFileSync(file, 'utf-8');
        const fileChecksum = checksum(normalizeSqlForChecksum(sql));
        const appliedRecord = await findAppliedMigration(client, group.key, display);

        if (appliedRecord) {
          if (appliedRecord.checksum !== fileChecksum) {
            if (group.key === 'migrations') {
              throw new CliError('MIGRATION_DRIFT', `Migration ${display} changed after it was applied`, {
                hint: 'Applied migrations are immutable. Restore the file (e.g. `git checkout -- '
                  + `${display}\`), change accessnexus.schema.ts instead and run \`npx accessnexus generate\` to get a new __changes migration.`,
                data: progress(),
              });
            }

            if (appliedRecord.hashStrategy !== 'normalized_sql_v1') {
              await refreshAppliedMigrationChecksum(client, group.key, display, fileChecksum);
              skipped.push({ path: display, reason: 'checksum_normalized' });
              log(`  ${paint.gray('-')} ${display} (checksum normalized)`);
              continue;
            }
          } else {
            skipped.push({ path: display, reason: 'already_applied' });
            log(`  ${paint.gray('-')} ${display} (already applied)`);
            continue;
          }
        }

        const startedAt = Date.now();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          const record = {
            category: group.key,
            filename: display,
            checksum: fileChecksum,
            executionTimeMs: Date.now() - startedAt,
          };
          if (appliedRecord) await updateAppliedMigration(client, record);
          else await recordMigration(client, { ...record, success: true });
          await client.query('COMMIT');
        } catch (error: any) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ignore rollback errors and preserve the root SQL error
          }
          const pgMessage = String(error?.message ?? 'unknown SQL error');
          try {
            await recordMigration(client, {
              category: group.key,
              filename: display,
              checksum: fileChecksum,
              executionTimeMs: Date.now() - startedAt,
              success: false,
              logs: pgMessage.slice(0, 4000),
            });
          } catch {
            // best effort only, do not hide root SQL error
          }
          throw new CliError('PUSH_FAILED', `Postgres rejected ${display}: ${pgMessage}`, {
            hint: `${display} was rolled back; files listed in "applied" stay applied. `
              + 'Fix the cause in accessnexus.schema.ts (or the database state), run `npx accessnexus generate`, then push again.',
            data: progress(),
            cause: error,
          });
        }
        applied.push(display);
        log(`  ${paint.green('✓')} ${display}${appliedRecord ? paint.gray(' (re-applied: changed)') : ''}`);
      }
      log('');
    }
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

type OutputCategory = 'migrations' | 'policies' | 'triggers' | 'rpcs' | 'sdk';

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
  return files.map((file) => {
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
