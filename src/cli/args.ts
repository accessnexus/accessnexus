// ============================================
// AccessNexus CLI - Argument parsing
// Strict per-command flags: a typo fails fast with a suggestion instead of
// being silently ignored (agents mistype flags; silence is the worst outcome).
// ============================================

import { CliError } from './output.js';

export type FlagKind = 'boolean' | 'string';

export interface FlagSpec {
  readonly kind: FlagKind;
  readonly description: string;
  /** Placeholder shown in help for string flags, e.g. `<path>`. */
  readonly value?: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export type ParsedFlags = Record<string, string | boolean>;

/** Flags accepted by every command. */
export const GLOBAL_FLAGS: FlagSpecs = {
  json: { kind: 'boolean', description: 'Print one JSON object on stdout (no colors, no progress output)' },
  verbose: { kind: 'boolean', description: 'Show debug output and stack traces (same as DEBUG=accessnexus)' },
  help: { kind: 'boolean', description: 'Show help for the command' },
  config: { kind: 'string', value: '<path>', description: 'Config file (default: accessnexus.config.{ts,js,mjs} in cwd)' },
};

const SHORT_ALIASES: Readonly<Record<string, string>> = {
  '-h': 'help',
  '-y': 'yes',
};

/**
 * Parse `argv` against the given flag specs.
 * Supports `--flag value`, `--flag=value`, boolean `--flag`, and the `--no-<flag>`
 * form for booleans declared as `no-<flag>`.
 */
export function parseFlags(args: readonly string[], specs: FlagSpecs, command: string): ParsedFlags {
  const all: FlagSpecs = { ...GLOBAL_FLAGS, ...specs };
  const result: ParsedFlags = {};

  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    let name: string;
    let inlineValue: string | undefined;

    if (SHORT_ALIASES[raw]) {
      name = SHORT_ALIASES[raw];
    } else if (raw.startsWith('--')) {
      const body = raw.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        name = body.slice(0, eq);
        inlineValue = body.slice(eq + 1);
      } else {
        name = body;
      }
    } else {
      throw new CliError('UNEXPECTED_ARGUMENT', `Unexpected argument "${raw}" for \`${command}\``, {
        hint: `Flags start with "--". Run \`npx accessnexus ${command} --help\` to see the accepted flags.`,
      });
    }

    const spec = all[name];
    if (!spec) {
      const suggestion = closest(name, Object.keys(all));
      throw new CliError('UNKNOWN_FLAG', `Unknown flag "--${name}" for \`${command}\``, {
        hint: suggestion
          ? `Did you mean --${suggestion}? Run \`npx accessnexus ${command} --help\` for all flags.`
          : `Run \`npx accessnexus ${command} --help\` to see the accepted flags.`,
      });
    }

    if (spec.kind === 'boolean') {
      if (inlineValue !== undefined) {
        throw new CliError('INVALID_FLAG_VALUE', `Flag "--${name}" does not take a value`, {
          hint: `Use "--${name}" on its own.`,
        });
      }
      result[name] = true;
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new CliError('MISSING_FLAG_VALUE', `Flag "--${name}" needs a value`, {
          hint: `Pass it as --${name} ${spec.value ?? '<value>'}.`,
        });
      }
      value = next;
      i++;
    }
    result[name] = value;
  }

  return result;
}

/** Render a flag table for `--help`. */
export function formatFlags(specs: FlagSpecs): string {
  const rows = Object.entries({ ...specs, ...GLOBAL_FLAGS }).map(([name, spec]) => {
    const left = `--${name}${spec.kind === 'string' ? ` ${spec.value ?? '<value>'}` : ''}`;
    return [left, spec.description] as const;
  });
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, desc]) => `  ${left.padEnd(width)}${desc}`).join('\n');
}

/** Closest candidate by edit distance (max 3), for "did you mean" hints. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = editDistance(input, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}
