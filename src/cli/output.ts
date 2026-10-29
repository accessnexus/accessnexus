// ============================================
// AccessNexus CLI - Output, colors and errors
// One place that decides what goes to stdout/stderr, so `--json` output stays
// a single clean JSON object and errors always read: what / why / how to fix.
// ============================================

/** Exit codes — part of the public CLI contract (documented in llms.txt). */
export const EXIT = {
  /** Command succeeded. */
  OK: 0,
  /** User-fixable problem: bad flag, missing file, invalid schema, DB unreachable, SQL rejected... */
  USER: 1,
  /** Unexpected internal failure (a AccessNexus bug). */
  INTERNAL: 2,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A single problem found while validating a schema. */
export interface SchemaIssue {
  severity: 'error' | 'warning';
  /** Stable machine-readable code, e.g. `UNKNOWN_COLUMN`. */
  code: string;
  /** Dotted location in the schema, e.g. `posts.policies.update`. */
  path: string;
  message: string;
  hint?: string;
}

/**
 * A user-facing failure. Carries a stable `code`, a message that says what went
 * wrong and a `hint` that says how to fix it. Rendered without a stack trace
 * unless `--verbose` / `DEBUG=accessnexus` is set.
 */
export class CliError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly exitCode: ExitCode;
  readonly issues?: SchemaIssue[];
  /** Extra fields merged into the `--json` result (e.g. the diff that failed `--check`). */
  readonly data?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      hint?: string;
      exitCode?: ExitCode;
      issues?: SchemaIssue[];
      data?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CliError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? EXIT.USER;
    this.issues = options.issues;
    this.data = options.data;
  }
}

// ---- Output state (configured once per CLI run) ----

interface UiState {
  json: boolean;
  verbose: boolean;
  color: boolean;
}

const state: UiState = {
  json: false,
  verbose: false,
  color: detectColor(),
};

function detectColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

/** True when `DEBUG` asks for AccessNexus internals (`DEBUG=accessnexus`, `DEBUG=accessnexus*`, `DEBUG=*`). */
export function debugEnabled(): boolean {
  const debug = process.env.DEBUG ?? '';
  return debug.split(/[\s,]+/).some((part) => part === '*' || part.startsWith('accessnexus'));
}

export function configureUi(options: { json?: boolean; verbose?: boolean }): void {
  state.json = options.json ?? false;
  state.verbose = (options.verbose ?? false) || debugEnabled();
  state.color = state.json ? false : detectColor();
}

export function isJsonMode(): boolean {
  return state.json;
}

export function isVerbose(): boolean {
  return state.verbose;
}

// ---- Colors (no-ops when stdout is not a TTY, NO_COLOR is set, or --json) ----

function wrap(open: string): (s: string) => string {
  return (s: string) => (state.color ? `\x1b[${open}m${s}\x1b[0m` : s);
}

export const paint = {
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  gray: wrap('90'),
  bold: wrap('1'),
  dim: wrap('2'),
} as const;

export const brand = (): string => paint.bold(paint.cyan('⬡ AccessNexus'));

// ---- Human output (suppressed in --json mode) ----

/** Human-readable line on stdout. Silent in `--json` mode. */
export function log(message = ''): void {
  if (state.json) return;
  console.log(message);
}

/** Human-readable warning on stderr. Silent in `--json` mode (warnings go in the JSON). */
export function warn(message: string): void {
  if (state.json) return;
  console.error(`  ${paint.yellow('!')} ${message}`);
}

/** Debug detail, only with `--verbose` or `DEBUG=accessnexus`. Always on stderr. */
export function debug(message: string): void {
  if (!state.verbose) return;
  console.error(paint.gray(`[accessnexus:debug] ${message}`));
}

/** Write the single JSON result object to stdout. */
export function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// ---- Error rendering ----

/** Normalize anything thrown into a CliError (unknown errors become INTERNAL_ERROR). */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);

  // Builder validation errors (`defineSchema`, `definePermissions`...) are user mistakes.
  if (message.startsWith('[AccessNexus]')) {
    return new CliError('SCHEMA_INVALID', message.replace(/^\[AccessNexus\]\s*/, ''), {
      hint: 'Fix the schema definition named in the message, then run `npx accessnexus validate`.',
      cause: err,
    });
  }

  return new CliError('INTERNAL_ERROR', message || 'Unexpected error', {
    exitCode: EXIT.INTERNAL,
    hint: 'This looks like a AccessNexus bug. Re-run with --verbose (or DEBUG=accessnexus) and report the stack trace.',
    cause: err,
  });
}

/** Serialize an error for `--json` output. */
export function errorToJson(err: CliError): Record<string, unknown> {
  const out: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.hint) out.hint = err.hint;
  // Schema issues travel in the top-level `issues` array (see CliError.data), not here.
  if (state.verbose) out.stack = stackOf(err);
  return out;
}

/** Print an error for humans on stderr: what happened, how to fix it, stack only when verbose. */
export function printError(err: CliError): void {
  console.error(`\n${paint.red(`✗ ${err.message}`)} ${paint.gray(`[${err.code}]`)}`);
  if (err.issues && err.issues.length > 0) {
    console.error('');
    for (const issue of err.issues) printIssue(issue, true);
  }
  if (err.hint) {
    console.error(`\n  ${paint.bold('Fix:')} ${err.hint}`);
  }
  if (state.verbose) {
    console.error(`\n${paint.gray(stackOf(err))}`);
  } else if (err.exitCode === EXIT.INTERNAL) {
    console.error(paint.gray('\n  (stack trace hidden — re-run with --verbose or DEBUG=accessnexus)'));
  }
  console.error('');
}

/** Print one schema issue (errors and warnings share the format). */
export function printIssue(issue: SchemaIssue, toStderr = false): void {
  if (state.json) return;
  const out = toStderr || issue.severity === 'error' ? console.error : console.log;
  const marker = issue.severity === 'error' ? paint.red('✗') : paint.yellow('!');
  out(`  ${marker} ${paint.bold(issue.path)}: ${issue.message} ${paint.gray(`[${issue.code}]`)}`);
  if (issue.hint) out(`    ${paint.dim(`→ ${issue.hint}`)}`);
}

function stackOf(err: Error): string {
  const parts: string[] = [err.stack ?? err.message];
  let cause = (err as { cause?: unknown }).cause;
  while (cause instanceof Error) {
    parts.push(`Caused by: ${cause.stack ?? cause.message}`);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join('\n');
}
