// ============================================
// AccessNexus - Interactive Prompts
// Zero-dependency readline utilities
// ============================================

import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { CliError, log, paint } from '../output.js';

// ---- Color helpers (no-ops when not a TTY / NO_COLOR / --json) ----

export const c = {
  green: (s: string) => paint.green(s),
  red: (s: string) => paint.red(s),
  cyan: (s: string) => paint.cyan(s),
  bold: (s: string) => paint.bold(s),
  dim: (s: string) => paint.dim(s),
} as const;

// ---- Logging helpers (silent in --json mode) ----

export function success(msg: string): void {
  log(`  ${paint.green('✓')} ${msg}`);
}

export function error(msg: string): void {
  log(`  ${paint.red('✗')} ${msg}`);
}

export function info(msg: string): void {
  log(`  ${paint.cyan('→')} ${msg}`);
}

export function header(): void {
  log(`\n${paint.bold(paint.cyan('⬡ AccessNexus'))} init\n`);
}

// ---- Interactive prompts ----
// In non-interactive mode (`init --yes`) prompts never read stdin: they return
// their default, or fail with a clear error naming the flag to pass instead.

let interactive = true;

export function setInteractive(value: boolean): void {
  interactive = value;
}

export function isInteractive(): boolean {
  return interactive;
}

function needsInput(question: string, flag?: string): CliError {
  return new CliError('INIT_NEEDS_INPUT', `"${question}" needs an answer, but init is running non-interactively`, {
    hint: flag ? `Pass ${flag}.` : 'Run init in a terminal, or pass the matching flag (see `npx accessnexus init --help`).',
  });
}

export async function prompt(question: string, defaultValue?: string, flag?: string): Promise<string> {
  if (!interactive) {
    if (defaultValue !== undefined) return defaultValue;
    throw needsInput(question, flag);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const suffix = defaultValue ? ` ${c.dim(`(${defaultValue})`)}` : '';
  try {
    const answer = await rl.question(`  ? ${question}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  if (!interactive) return defaultYes;
  const rl = createInterface({ input: stdin, output: stdout });
  const hint = defaultYes ? 'Y/n' : 'y/N';
  try {
    const answer = await rl.question(`  ? ${question} ${c.dim(`(${hint})`)}: `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '') return defaultYes;
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

export async function promptSecret(question: string, flag?: string): Promise<string> {
  if (!interactive || !process.stdin.isTTY) throw needsInput(question, flag);
  return new Promise((resolve) => {
    process.stdout.write(`  ? ${question}: `);

    const { stdin: stdinRaw } = process;
    stdinRaw.setRawMode(true);
    stdinRaw.resume();
    stdinRaw.setEncoding('utf8');

    let input = '';

    const onData = (ch: string) => {
      if (ch === '\n' || ch === '\r') {
        stdinRaw.setRawMode(false);
        stdinRaw.pause();
        stdinRaw.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        // Ctrl+C
        stdinRaw.setRawMode(false);
        stdinRaw.pause();
        stdinRaw.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '\u007f') {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    };

    stdinRaw.on('data', onData);
  });
}
